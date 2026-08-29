import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createS3Client,
  deleteObject,
  putObject,
  readObject,
  readObjectVersion
} from '../../server/s3.ts'
import type { S3AgencyConfig, S3Credential } from '../../shared/config.ts'

const timeoutMs = 150
const credential: S3Credential = {
  service: 'backblaze-b2',
  accessKeyId: 'local-test-key',
  secretAccessKey: 'local-test-secret'
}

const withStalledServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (endpoint: string, methods: string[]) => Promise<void>
): Promise<void> => {
  const methods: string[] = []
  const server = createServer((request, response) => {
    methods.push(request.method ?? 'UNKNOWN')
    handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, methods)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
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

const expectBounded = async (operation: () => Promise<unknown>): Promise<void> => {
  const startedAt = Date.now()
  await expect(operation()).rejects.toBeTruthy()
  expect(Date.now() - startedAt).toBeLessThan(2_000)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S3 stalled HTTP transport deadlines', () => {
  it('aborts a stalled PUT after one write attempt and uses a fresh HEAD request for recovery', async () => {
    await withStalledServer((request, response) => {
      request.resume()
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-length': '0' })
        response.end()
      }
    }, async (endpoint, methods) => {
      const config = localConfig(endpoint)
      const client = createS3Client(config, credential, { maxAttempts: 1, requestTimeoutMs: timeoutMs })
      try {
        await expectBounded(() => putObject(client, config, 'object', new Uint8Array([1]), 'x/test', { timeoutMs }))
        expect(methods.filter(method => method === 'PUT')).toHaveLength(1)
        expect(methods.filter(method => method === 'HEAD')).toHaveLength(1)
      } finally {
        client.destroy()
      }
    })
  })

  it('aborts while consuming a GET response body that never completes', async () => {
    await withStalledServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-length': '2', 'content-type': 'application/octet-stream' })
      response.write(new Uint8Array([1]))
    }, async (endpoint, methods) => {
      const config = localConfig(endpoint)
      const client = createS3Client(config, credential, { requestTimeoutMs: timeoutMs })
      try {
        await expectBounded(() => readObject(client, config, 'object', undefined, { timeoutMs }))
        expect(methods).toEqual(['GET'])
      } finally {
        client.destroy()
      }
    })
  })

  it('aborts a stalled HEAD while retaining the standard client retry configuration', async () => {
    await withStalledServer(request => request.resume(), async (endpoint, methods) => {
      const config = localConfig(endpoint)
      const client = createS3Client(config, credential, { requestTimeoutMs: timeoutMs })
      try {
        await expect(client.config.maxAttempts()).resolves.toBe(3)
        await expectBounded(() => readObjectVersion(client, config, 'object', { timeoutMs }))
        expect(methods.filter(method => method === 'HEAD')).toHaveLength(1)
      } finally {
        client.destroy()
      }
    })
  })

  it('aborts a stalled exact-version DELETE while retaining the standard client retry configuration', async () => {
    await withStalledServer(request => request.resume(), async (endpoint, methods) => {
      const config = localConfig(endpoint)
      const client = createS3Client(config, credential, { requestTimeoutMs: timeoutMs })
      try {
        await expect(client.config.maxAttempts()).resolves.toBe(3)
        await expectBounded(() => deleteObject(client, config, 'object', 'version-1', { timeoutMs }))
        expect(methods.filter(method => method === 'DELETE')).toHaveLength(1)
      } finally {
        client.destroy()
      }
    })
  })
})
