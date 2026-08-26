import { describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../../server/storage-adapter'

const agencyConfig = { bucket: 'bucket', region: 'ca-central-1', keyPrefix: 'p', credentialMode: 'default-chain', encryption: 'bucket-default' }
const secrets = { get: vi.fn().mockResolvedValue(null) }
const base = { agencyId: '17', purpose: 'attachment' as const, agencyConfig, secrets }

describe('S3 storage adapter', () => {
  it('writes, reads, and deletes while preserving stable identity', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([9]) } }).mockResolvedValueOnce({})
    const destroy = vi.fn()
    const adapter = createStorageAdapter({ createClient: (() => ({ send, destroy })) as never })
    const reference = await adapter.writeObject({ ...base, objectName: 'object', bytes: new Uint8Array([1]), contentType: 'x/test' })
    expect(reference).toEqual({
      objectId: 'p/object',
      locator: { key: 'p/object', bucket: 'bucket', region: 'ca-central-1' }
    })
    await expect(adapter.readObject({ ...base, ...reference })).resolves.toEqual({ bytes: new Uint8Array([9]) })
    await expect(adapter.deleteObject({ ...base, ...reference })).resolves.toBeUndefined()
    expect(destroy).toHaveBeenCalledTimes(3)
  })
  it('uses explicit agency credentials only through the resolver', async () => {
    const secretReader = { get: vi.fn().mockResolvedValue({ accessKeyId: 'id', secretAccessKey: 'secret' }) }
    let receivedCredential: unknown
    const createClient = ((_config: unknown, credential: unknown) => { receivedCredential = credential; return { send: vi.fn().mockResolvedValue({}), destroy: vi.fn() } })
    const adapter = createStorageAdapter({ createClient: createClient as never })
    await adapter.writeObject({ ...base, secrets: secretReader, agencyConfig: { ...agencyConfig, credentialMode: 'agency-secret' }, objectName: 'object', bytes: new Uint8Array(), contentType: 'x/test' })
    expect(secretReader.get).toHaveBeenCalledWith('aws-credentials')
    expect(receivedCredential).toEqual({ accessKeyId: 'id', secretAccessKey: 'secret' })
  })
  it('fails closed for missing credentials and malformed locators', async () => {
    const adapter = createStorageAdapter({ createClient: (() => ({ send: vi.fn(), destroy: vi.fn() })) as never })
    await expect(adapter.writeObject({ ...base, agencyConfig: { ...agencyConfig, credentialMode: 'agency-secret' }, objectName: 'object', bytes: new Uint8Array(), contentType: 'x' })).rejects.toThrow('credentials are unavailable')
    await expect(adapter.readObject({ ...base, objectId: 'a', locator: { key: 'b' } })).rejects.toThrow('Invalid S3 storage object locator')
  })
})
