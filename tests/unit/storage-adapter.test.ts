import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { GCS_FILE_STORAGE_PROVIDER_OBJECT_ID_MAX_BYTES } from '@gcs-ssc/extensions/server'
import { describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../../server/storage-adapter'

const agencyConfig = { bucket: 'bucket', region: 'ca-central-1', keyPrefix: 'p', credentialMode: 'default-chain', encryption: 'bucket-default' }
const secrets = { get: vi.fn().mockResolvedValue(null) }
const base = { agencyId: '17', purpose: 'attachment' as const, agencyConfig, secrets }
const templateObjectNameBase = '17/document-templates/1700000000000-abcdefghij-'
const templateObjectNameAtLimit = `${templateObjectNameBase}${'a'.repeat(
  GCS_FILE_STORAGE_PROVIDER_OBJECT_ID_MAX_BYTES - Buffer.byteLength(templateObjectNameBase, 'utf8') - Buffer.byteLength('.html', 'utf8')
)}.html`

describe('S3 storage adapter', () => {
  it('writes, reads, and deletes while preserving stable identity', async () => {
    const send = vi.fn().mockResolvedValueOnce({ VersionId: 'version-1' }).mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([9]) } }).mockResolvedValueOnce({})
    const destroy = vi.fn()
    const createClient = vi.fn((_config: unknown, _credential?: unknown, _options?: unknown) => ({ send, destroy }))
    const adapter = createStorageAdapter({ createClient: createClient as never, operationTimeoutMs: 250 })
    const reference = await adapter.writeObject({ ...base, objectName: 'object', bytes: new Uint8Array([1]), contentType: 'x/test' })
    expect(reference).toEqual({
      objectId: 'p/object',
      locator: { key: 'p/object', bucket: 'bucket', region: 'ca-central-1', service: 'amazon-s3', forcePathStyle: false, versionId: 'version-1' }
    })
    await expect(adapter.readObject({ ...base, ...reference })).resolves.toEqual({ bytes: new Uint8Array([9]) })
    await expect(adapter.deleteObject({ ...base, ...reference })).resolves.toBeUndefined()
    expect(destroy).toHaveBeenCalledTimes(3)
    expect(createClient.mock.calls[0]?.[2]).toEqual({ maxAttempts: 1, requestTimeoutMs: 250 })
    expect(createClient.mock.calls[1]?.[2]).toEqual({ requestTimeoutMs: 250 })
    expect(createClient.mock.calls[2]?.[2]).toEqual({ requestTimeoutMs: 250 })
  })
  it('pins B2 service and endpoint in the locator for later reads', async () => {
    const createClient = vi.fn(() => ({
      send: vi.fn(async command => command instanceof PutObjectCommand ? { VersionId: 'b2-version' } : {}),
      destroy: vi.fn()
    }))
    const adapter = createStorageAdapter({ createClient: createClient as never, operationTimeoutMs: 250 })
    const b2Config = {
      service: 'backblaze-b2', bucket: 'b2-bucket', endpoint: 's3.us-east-005.backblazeb2.com',
      keyPrefix: 'p', credentialMode: 'agency-secret', encryption: 'bucket-default'
    }
    const secretReader = { get: vi.fn().mockResolvedValue({ service: 'backblaze-b2', accessKeyId: 'id', secretAccessKey: 'secret' }) }
    const reference = await adapter.writeObject({ ...base, agencyConfig: b2Config, secrets: secretReader, objectName: 'object', bytes: new Uint8Array(), contentType: 'x/test' })
    expect(reference.locator).toEqual({
      key: 'p/object', bucket: 'b2-bucket', region: 'us-east-005', service: 'backblaze-b2',
      endpoint: 'https://s3.us-east-005.backblazeb2.com', forcePathStyle: true, versionId: 'b2-version'
    })
    await adapter.deleteObject({ ...base, agencyConfig: b2Config, secrets: secretReader, ...reference })
    expect(createClient).toHaveBeenNthCalledWith(1, expect.objectContaining({
      service: 'backblaze-b2', bucket: 'b2-bucket', endpoint: 'https://s3.us-east-005.backblazeb2.com'
    }), expect.anything(), { maxAttempts: 1, requestTimeoutMs: 250 })
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      service: 'backblaze-b2', bucket: 'b2-bucket', endpoint: 'https://s3.us-east-005.backblazeb2.com'
    }), expect.anything(), { requestTimeoutMs: 250 })
  })
  it('uses explicit agency credentials only through the resolver', async () => {
    const secretReader = { get: vi.fn().mockResolvedValue({ accessKeyId: 'id', secretAccessKey: 'secret' }) }
    let receivedCredential: unknown
    const createClient = ((_config: unknown, credential: unknown) => { receivedCredential = credential; return { send: vi.fn().mockResolvedValue({}), destroy: vi.fn() } })
    const adapter = createStorageAdapter({ createClient: createClient as never })
    await adapter.writeObject({ ...base, secrets: secretReader, agencyConfig: { ...agencyConfig, credentialMode: 'agency-secret' }, objectName: 'object', bytes: new Uint8Array(), contentType: 'x/test' })
    expect(secretReader.get).toHaveBeenCalledWith('aws-credentials')
    expect(receivedCredential).toEqual({ service: 'amazon-s3', accessKeyId: 'id', secretAccessKey: 'secret' })
  })
  it.each([
    ['ASCII under limit', 'a'.repeat(509), 'x', 511],
    ['ASCII at limit', 'a'.repeat(510), 'x', 512],
    ['multibyte under limit', `${'é'.repeat(254)}a`, 'x', 511],
    ['multibyte at limit', 'é'.repeat(255), 'x', 512],
    ['long template name at limit', '', templateObjectNameAtLimit, 512]
  ])('writes an exact %s final key', async (_label, keyPrefix, objectName, expectedBytes) => {
    const send = vi.fn().mockResolvedValue({ VersionId: 'version-1' })
    const createClient = vi.fn(() => ({ send, destroy: vi.fn() }))
    const secretReader = { get: vi.fn().mockResolvedValue(null) }
    const adapter = createStorageAdapter({ createClient: createClient as never, operationTimeoutMs: 250 })

    const reference = await adapter.writeObject({
      ...base,
      agencyConfig: { ...agencyConfig, keyPrefix },
      secrets: secretReader,
      objectName,
      bytes: new Uint8Array([1]),
      contentType: 'x/test'
    })

    expect(Buffer.byteLength(reference.objectId, 'utf8')).toBe(expectedBytes)
    expect(createClient).toHaveBeenCalledOnce()
    expect(send.mock.calls.filter(call => call[0] instanceof PutObjectCommand)).toHaveLength(1)
    expect(secretReader.get).not.toHaveBeenCalled()
  })
  it.each([
    ['ASCII over limit', 'a'.repeat(511), 'x'],
    ['multibyte over limit', `${'é'.repeat(255)}a`, 'x'],
    ['long template name over limit', '', `${templateObjectNameAtLimit}a`]
  ])('rejects an exact %s final key before credentials, client creation, or PUT', async (_label, keyPrefix, objectName) => {
    const send = vi.fn()
    const createClient = vi.fn(() => ({ send, destroy: vi.fn() }))
    const secretReader = {
      get: vi.fn().mockResolvedValue({ accessKeyId: 'id', secretAccessKey: 'secret' })
    }
    const adapter = createStorageAdapter({ createClient: createClient as never, operationTimeoutMs: 250 })

    await expect(adapter.writeObject({
      ...base,
      agencyConfig: { ...agencyConfig, keyPrefix, credentialMode: 'agency-secret' },
      secrets: secretReader,
      objectName,
      bytes: new Uint8Array([1]),
      contentType: 'x/test'
    })).rejects.toThrow(`exceeds the ${GCS_FILE_STORAGE_PROVIDER_OBJECT_ID_MAX_BYTES}-byte`)

    expect(secretReader.get).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('fails closed for missing credentials and malformed locators', async () => {
    const adapter = createStorageAdapter({ createClient: (() => ({ send: vi.fn(), destroy: vi.fn() })) as never })
    await expect(adapter.writeObject({ ...base, agencyConfig: { ...agencyConfig, credentialMode: 'agency-secret' }, objectName: 'object', bytes: new Uint8Array(), contentType: 'x' })).rejects.toThrow('credentials are unavailable')
    await expect(adapter.readObject({ ...base, objectId: 'a', locator: { key: 'b' } })).rejects.toThrow('Invalid S3 storage object locator')
  })
  it('rejects a mismatched pinned backend before reading secrets or creating a client', async () => {
    const secretReader = { get: vi.fn() }
    const createClient = vi.fn()
    const adapter = createStorageAdapter({ createClient: createClient as never })
    await expect(adapter.deleteObject({
      ...base,
      secrets: secretReader,
      objectId: 'object',
      locator: {
        key: 'object', service: 'backblaze-b2', bucket: 'bucket', region: 'us-east-005',
        endpoint: 'https://s3.us-east-005.backblazeb2.com', forcePathStyle: true
      }
    })).rejects.toThrow('does not match the configured storage backend')
    expect(secretReader.get).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })
  it('resolves a legacy locator version before deleting it', async () => {
    const send = vi.fn().mockResolvedValueOnce({ VersionId: 'legacy-version' }).mockResolvedValueOnce({})
    const adapter = createStorageAdapter({ createClient: (() => ({ send, destroy: vi.fn() })) as never })
    await adapter.deleteObject({
      ...base,
      objectId: 'legacy-object',
      locator: { key: 'legacy-object', bucket: 'bucket', region: 'ca-central-1' }
    })
    expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([HeadObjectCommand, DeleteObjectCommand])
    expect((send.mock.calls[1]?.[0] as DeleteObjectCommand).input.VersionId).toBe('legacy-version')
  })
  it('destroys the client after a stalled PUT and its bounded ambiguous HEAD cleanup', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const send = vi.fn((_command: unknown, _options?: unknown) => new Promise(() => {}))
      const destroy = vi.fn()
      const adapter = createStorageAdapter({
        createClient: (() => ({ send, destroy })) as never,
        operationTimeoutMs: 100
      })
      const pending = adapter.writeObject({ ...base, objectName: 'object', bytes: new Uint8Array([1]), contentType: 'x/test' })
      const rejection = expect(pending).rejects.toThrow('S3 put operation timed out')
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(send.mock.calls.filter(call => call[0] instanceof PutObjectCommand)).toHaveLength(1)
      expect(send.mock.calls.filter(call => call[0] instanceof HeadObjectCommand)).toHaveLength(1)
      expect(destroy).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })
  it('destroys the client after stalled GET body consumption', async () => {
    vi.useFakeTimers()
    try {
      const bodyDestroy = vi.fn()
      const send = vi.fn().mockResolvedValue({
        Body: { destroy: bodyDestroy, transformToByteArray: () => new Promise(() => {}) }
      })
      const destroy = vi.fn()
      const adapter = createStorageAdapter({
        createClient: (() => ({ send, destroy })) as never,
        operationTimeoutMs: 100
      })
      const pending = adapter.readObject({
        ...base,
        objectId: 'object',
        locator: { key: 'object', bucket: 'bucket', region: 'ca-central-1' }
      })
      const rejection = expect(pending).rejects.toThrow('S3 get-body operation timed out')
      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(bodyDestroy).toHaveBeenCalledOnce()
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('destroys the client after a stalled legacy-version HEAD', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn((_command: unknown, _options?: unknown) => new Promise(() => {}))
      const destroy = vi.fn()
      const adapter = createStorageAdapter({
        createClient: (() => ({ send, destroy })) as never,
        operationTimeoutMs: 100
      })
      const pending = adapter.deleteObject({
        ...base,
        objectId: 'object',
        locator: { key: 'object', bucket: 'bucket', region: 'ca-central-1' }
      })
      const rejection = expect(pending).rejects.toThrow('S3 head operation timed out')
      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([HeadObjectCommand])
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('destroys the client after a stalled exact-version DELETE', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn((_command: unknown, _options?: unknown) => new Promise(() => {}))
      const destroy = vi.fn()
      const adapter = createStorageAdapter({
        createClient: (() => ({ send, destroy })) as never,
        operationTimeoutMs: 100
      })
      const pending = adapter.deleteObject({
        ...base,
        objectId: 'object',
        locator: { key: 'object', bucket: 'bucket', region: 'ca-central-1', versionId: 'version-1' }
      })
      const rejection = expect(pending).rejects.toThrow('S3 delete operation timed out')
      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([DeleteObjectCommand])
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
