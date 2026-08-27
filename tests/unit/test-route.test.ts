import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadCredential = vi.fn()
const testConnection = vi.fn()
const destroyClient = vi.fn()

vi.mock('../../server/credentials', () => ({ loadCredential }))
vi.mock('../../server/s3', () => ({
  createS3Client: vi.fn(() => ({ send: vi.fn(), destroy: destroyClient })),
  testS3Connection: testConnection
}))

const { testStorageConnection } = await import('../../server/api/test.post')

const context = (body: unknown) => ({
  db: {},
  params: { agencyId: '17' },
  readBody: async () => body
}) as never

describe('S3 connection-test route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadCredential.mockResolvedValue(null)
    testConnection.mockResolvedValue(undefined)
  })

  it('maps invalid configuration to a structured bilingual validation error', async () => {
    await expect(testStorageConnection(context({}))).rejects.toMatchObject({
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CONFIG_INVALID',
      localizedMessage: expect.objectContaining({ en: expect.any(String), fr: expect.any(String) })
    })
  })

  it('returns a stable conflict when agency credentials have not been saved', async () => {
    await expect(testStorageConnection(context({
      service: 'amazon-s3',
      bucket: 'bucket',
      region: 'ca-central-1',
      credentialMode: 'agency-secret'
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'GCS_STORAGE_S3_CREDENTIALS_MISSING'
    })
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('hides raw provider failures and still destroys the client', async () => {
    testConnection.mockRejectedValue(new Error('secret provider response'))
    await expect(testStorageConnection(context({
      service: 'amazon-s3',
      bucket: 'bucket',
      region: 'ca-central-1'
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CONNECTION_FAILED'
    })
    expect(destroyClient).toHaveBeenCalledOnce()
  })
})
