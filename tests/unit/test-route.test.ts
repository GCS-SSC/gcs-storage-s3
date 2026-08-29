import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadCredential = vi.fn()
const withLockedConfiguration = vi.fn()
const createClient = vi.fn()
const testConnection = vi.fn()
const destroyClient = vi.fn()

vi.mock('../../server/credentials', () => ({ loadCredential, withLockedS3Configuration: withLockedConfiguration }))
vi.mock('../../server/s3', () => ({
  createS3Client: createClient,
  resolveS3CanaryTimeoutMs: () => 5_000,
  testS3Connection: testConnection
}))

const { testStorageConnection } = await import('../../server/api/test.post')

const context = (body: unknown) => ({
  db: {},
  params: { agencyId: '17' },
  readBody: vi.fn(async () => body)
})

describe('S3 connection-test route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createClient.mockReturnValue({ send: vi.fn(), destroy: destroyClient })
    loadCredential.mockResolvedValue(null)
    testConnection.mockResolvedValue(undefined)
    withLockedConfiguration.mockImplementation(async (_context, callback) => await callback({
      service: 'amazon-s3',
      bucket: 'saved-bucket',
      region: 'ca-central-1',
      credentialMode: 'agency-secret',
      encryption: 'bucket-default',
      forcePathStyle: false,
      keyPrefix: ''
    }, { marker: 'locked-transaction' }, '17'))
  })

  it('uses only the saved locked backend and never reads a request-supplied backend', async () => {
    const requestContext = context({
      service: 'backblaze-b2',
      bucket: 'attacker-selected-bucket',
      endpoint: 'https://attacker.example'
    })
    loadCredential.mockResolvedValue({
      service: 'amazon-s3',
      accessKeyId: 'saved-key',
      secretAccessKey: 'saved-secret'
    })

    await expect(testStorageConnection(requestContext as never)).resolves.toEqual({ ok: true })

    expect(requestContext.readBody).not.toHaveBeenCalled()
    expect(loadCredential).toHaveBeenCalledWith({ marker: 'locked-transaction' }, '17')
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      service: 'amazon-s3',
      bucket: 'saved-bucket'
    }), expect.objectContaining({ accessKeyId: 'saved-key' }), { maxAttempts: 1, requestTimeoutMs: 5_000 })
    expect(testConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bucket: 'saved-bucket' }), { timeoutMs: 5_000 })
  })

  it('returns a stable conflict when agency credentials have not been saved', async () => {
    await expect(testStorageConnection(context({
      service: 'amazon-s3',
      bucket: 'bucket',
      region: 'ca-central-1',
      credentialMode: 'agency-secret'
    }) as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'GCS_STORAGE_S3_CREDENTIALS_MISSING'
    })
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('hides raw provider failures and still destroys the client', async () => {
    withLockedConfiguration.mockImplementationOnce(async (_context, callback) => await callback({
      service: 'amazon-s3',
      bucket: 'saved-bucket',
      region: 'ca-central-1',
      credentialMode: 'default-chain',
      encryption: 'bucket-default',
      forcePathStyle: false,
      keyPrefix: ''
    }, { marker: 'locked-transaction' }, '17'))
    testConnection.mockRejectedValue(new Error('secret provider response'))
    await expect(testStorageConnection(context({
      service: 'amazon-s3',
      bucket: 'bucket',
      region: 'ca-central-1'
    }) as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CONNECTION_FAILED'
    })
    expect(destroyClient).toHaveBeenCalledOnce()
  })
})
