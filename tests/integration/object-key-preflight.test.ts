import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  GCS_FILE_STORAGE_PROVIDER_OBJECT_ID_MAX_BYTES,
  type GcsFileStorageSecretReader,
  type GcsFileStorageWriteObjectInput
} from '@gcs-ssc/extensions/server'
import { describe, expect, it, vi } from 'vitest'
import { createS3Client } from '../../server/s3.ts'
import { createStorageAdapter } from '../../server/storage-adapter.ts'
import type { S3AgencyConfig, S3Credential } from '../../shared/config.ts'

const credential: S3Credential = {
  service: 'backblaze-b2',
  accessKeyId: 'local-test-key',
  secretAccessKey: 'local-test-secret'
}

const providerConfig = {
  service: 'amazon-s3',
  bucket: 'bucket',
  region: 'ca-central-1',
  keyPrefix: '',
  credentialMode: 'default-chain',
  encryption: 'bucket-default'
}

const localConfig = (endpoint: string): S3AgencyConfig => ({
  service: 'backblaze-b2',
  bucket: 'bucket',
  region: 'local-1',
  endpoint,
  keyPrefix: '',
  credentialMode: 'agency-secret',
  encryption: 'bucket-default',
  forcePathStyle: true
})

const requestKey = (request: IncomingMessage): string => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  return decodeURIComponent(url.pathname.split('/').filter(Boolean).slice(1).join('/'))
}

const handleObjectRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  methods: string[],
  objects: Set<string>
): void => {
  const method = request.method ?? 'UNKNOWN'
  const key = requestKey(request)
  methods.push(method)
  request.resume()
  request.once('end', () => {
    if (method === 'PUT') {
      objects.add(key)
      response.writeHead(200, { 'x-amz-version-id': `version-${objects.size}` })
      response.end()
      return
    }
    if (method === 'DELETE') {
      objects.delete(key)
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
}

const withLoopbackObjectStore = async (
  run: (endpoint: string, methods: string[], objects: Set<string>) => Promise<void>
): Promise<void> => {
  const methods: string[] = []
  const objects = new Set<string>()
  const server = createServer((request, response) => handleObjectRequest(request, response, methods, objects))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, methods, objects)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

const operation = (
  keyPrefix: string,
  objectName: string,
  secrets: GcsFileStorageSecretReader = { get: async () => null },
  credentialMode: 'default-chain' | 'agency-secret' = 'default-chain'
): GcsFileStorageWriteObjectInput => ({
  agencyId: '17',
  purpose: 'document-template' as const,
  agencyConfig: { ...providerConfig, keyPrefix, credentialMode },
  secrets,
  objectName,
  bytes: new TextEncoder().encode('template'),
  contentType: 'text/html'
})

describe('S3 final object-key preflight over loopback HTTP', () => {
  it.each([
    ['ASCII', 'a'.repeat(510)],
    ['multibyte', 'é'.repeat(255)]
  ])('writes and exactly deletes a 512-byte %s key', async (_label, keyPrefix) => {
    await withLoopbackObjectStore(async (endpoint, methods, objects) => {
      const createClient = vi.fn((
        _config: S3AgencyConfig,
        _resolvedCredential: S3Credential | undefined,
        options: Parameters<typeof createS3Client>[2]
      ) => createS3Client(localConfig(endpoint), credential, options))
      const adapter = createStorageAdapter({ createClient: createClient as never, operationTimeoutMs: 1_000 })
      const reference = await adapter.writeObject(operation(keyPrefix, 'x'))

      expect(Buffer.byteLength(reference.objectId, 'utf8')).toBe(GCS_FILE_STORAGE_PROVIDER_OBJECT_ID_MAX_BYTES)
      expect(methods).toEqual(['PUT'])
      expect(objects).toEqual(new Set([reference.objectId]))

      await adapter.deleteObject({
        agencyId: '17',
        purpose: 'document-template',
        agencyConfig: { ...providerConfig, keyPrefix },
        secrets: { get: async () => null },
        ...reference
      })
      expect(methods).toEqual(['PUT', 'DELETE'])
      expect(objects.size).toBe(0)
    })
  })

  it('rejects over-limit ASCII, multibyte, and long template keys with zero remote residue', async () => {
    await withLoopbackObjectStore(async (endpoint, methods, objects) => {
      const createClient = vi.fn((
        _config: S3AgencyConfig,
        _resolvedCredential: S3Credential | undefined,
        options: Parameters<typeof createS3Client>[2]
      ) => createS3Client(localConfig(endpoint), credential, options))
      const adapter = createStorageAdapter({ createClient: createClient as never, operationTimeoutMs: 1_000 })
      const templateBase = '17/document-templates/1700000000000-abcdefghij-'
      const templateAtLimit = `${templateBase}${'a'.repeat(
        GCS_FILE_STORAGE_PROVIDER_OBJECT_ID_MAX_BYTES - Buffer.byteLength(templateBase, 'utf8') - 5
      )}.html`
      const overLimitCases = [
        ['a'.repeat(511), 'x'],
        [`${'é'.repeat(255)}a`, 'x'],
        ['', `${templateAtLimit}a`]
      ]

      for (const [keyPrefix, objectName] of overLimitCases) {
        const secretGet = vi.fn(async () => ({
          accessKeyId: 'should-not-read', secretAccessKey: 'should-not-read'
        }))
        const input = operation(keyPrefix!, objectName!, { get: secretGet }, 'agency-secret')
        await expect(adapter.writeObject(input)).rejects.toThrow('provider object identity limit')
        expect(secretGet).not.toHaveBeenCalled()
      }

      expect(createClient).not.toHaveBeenCalled()
      expect(methods).toEqual([])
      expect(objects.size).toBe(0)
    })
  })
})
