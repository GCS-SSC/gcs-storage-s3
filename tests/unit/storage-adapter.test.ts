import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../../server/storage-adapter'

const agencyConfig = { bucket: 'bucket', region: 'ca-central-1', keyPrefix: 'p', credentialMode: 'default-chain', encryption: 'bucket-default' }
const secrets = { get: vi.fn().mockResolvedValue(null) }
const base = { agencyId: '17', purpose: 'attachment' as const, agencyConfig, secrets }

describe('S3 storage adapter', () => {
  it('writes, reads, and deletes while preserving stable identity', async () => {
    const send = vi.fn().mockResolvedValueOnce({ VersionId: 'version-1' }).mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([9]) } }).mockResolvedValueOnce({})
    const destroy = vi.fn()
    const adapter = createStorageAdapter({ createClient: (() => ({ send, destroy })) as never })
    const reference = await adapter.writeObject({ ...base, objectName: 'object', bytes: new Uint8Array([1]), contentType: 'x/test' })
    expect(reference).toEqual({
      objectId: 'p/object',
      locator: { key: 'p/object', bucket: 'bucket', region: 'ca-central-1', service: 'amazon-s3', forcePathStyle: false, versionId: 'version-1' }
    })
    await expect(adapter.readObject({ ...base, ...reference })).resolves.toEqual({ bytes: new Uint8Array([9]) })
    await expect(adapter.deleteObject({ ...base, ...reference })).resolves.toBeUndefined()
    expect(destroy).toHaveBeenCalledTimes(3)
  })
  it('pins B2 service and endpoint in the locator for later reads', async () => {
    const createClient = vi.fn(() => ({
      send: vi.fn(async command => command instanceof PutObjectCommand ? { VersionId: 'b2-version' } : {}),
      destroy: vi.fn()
    }))
    const adapter = createStorageAdapter({ createClient: createClient as never })
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
    }), expect.anything(), { maxAttempts: 1 })
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      service: 'backblaze-b2', bucket: 'b2-bucket', endpoint: 'https://s3.us-east-005.backblazeb2.com'
    }), expect.anything())
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
})
