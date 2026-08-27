import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSecret = vi.fn()
const setSecret = vi.fn()
const lockLifecycle = vi.fn()
const testConnection = vi.fn()
const destroyClient = vi.fn()
vi.mock('../../server/s3', () => ({
  createS3Client: vi.fn(() => ({ send: vi.fn(), destroy: destroyClient })),
  testS3Connection: testConnection
}))
vi.mock('@gcs-ssc/extensions/server', async importOriginal => ({
  ...await importOriginal<typeof import('@gcs-ssc/extensions/server')>(),
  getEncryptedExtensionSecret: getSecret,
  setEncryptedExtensionSecret: setSecret
  , lockGcsExtensionLifecycleScope: lockLifecycle
}))

const { getCredentialSummary, saveCredential } = await import('../../server/credentials')

const configurationQuery = {
  select: vi.fn(), where: vi.fn(), forUpdate: vi.fn(),
  executeTakeFirst: vi.fn().mockResolvedValue({
    enabled: true,
    config: { service: 'amazon-s3', bucket: 'bucket', region: 'ca-central-1' }
  })
}
configurationQuery.select.mockReturnValue(configurationQuery)
configurationQuery.where.mockReturnValue(configurationQuery)
configurationQuery.forUpdate.mockReturnValue(configurationQuery)
const transactionDb = { marker: 'trx', selectFrom: vi.fn().mockReturnValue(configurationQuery) }
const context = (body: unknown = {}) => ({
  db: { transaction: () => ({ execute: async (callback: (trx: unknown) => Promise<unknown>) => await callback(transactionDb) }) },
  params: { agencyId: '17' }, readBody: async () => body,
  writeAuthorization: {
    lockAuthState: vi.fn(), authorizeCurrentEntity: vi.fn(), authorizeCurrentScope: vi.fn()
  }
}) as never

describe('encrypted agency S3 credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testConnection.mockResolvedValue(undefined)
    process.env.GCS_EXTENSION_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64')
  })

  it('returns only masked credential metadata to the browser', async () => {
    getSecret.mockResolvedValue({ accessKeyId: 'AKIA12345678', secretAccessKey: 'never-return-this', sessionToken: 'also-private' })
    await expect(getCredentialSummary(context())).resolves.toEqual({ configured: true, accessKeyIdMasked: '********5678', hasSessionToken: true })
    expect(getSecret).toHaveBeenCalledWith(expect.objectContaining({ transaction: expect.any(Function) }), expect.objectContaining({ extensionKey: 'gcs-storage-s3', ownerType: 'agency', ownerId: '17', secretKey: 'aws-credentials' }))
  })

  it('reports an unconfigured secret without exposing values', async () => {
    getSecret.mockResolvedValue(null)
    await expect(getCredentialSummary(context())).resolves.toEqual({ configured: false, accessKeyIdMasked: null, hasSessionToken: false })
  })

  it('validates and encrypts credentials with masked non-secret metadata', async () => {
    setSecret.mockResolvedValue({ id: '1' })
    const result = await saveCredential(context({ service: 'amazon-s3', accessKeyId: 'AKIA12345678', secretAccessKey: 'private' }))
    expect(result).toEqual({ configured: true, accessKeyIdMasked: '********5678', hasSessionToken: false })
    expect(lockLifecycle).toHaveBeenCalledWith(transactionDb, 'gcs-storage-s3', '17')
    expect(setSecret).toHaveBeenCalledWith(transactionDb, expect.objectContaining({
      extensionKey: 'gcs-storage-s3', ownerType: 'agency', ownerId: '17', secretKey: 'aws-credentials',
      value: { service: 'amazon-s3', accessKeyId: 'AKIA12345678', secretAccessKey: 'private' },
      metadata: { accessKeyIdMasked: '********5678', hasSessionToken: false }
    }))
    expect(testConnection).toHaveBeenCalledOnce()
    expect(destroyClient).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('maps incomplete credential bodies to a structured validation error', async () => {
    await expect(saveCredential(context({ accessKeyId: '', secretAccessKey: '' }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CREDENTIALS_INVALID',
      details: expect.arrayContaining([expect.objectContaining({ path: 'accessKeyId' })])
    })
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('fails closed without the host encryption root key', async () => {
    delete process.env.GCS_EXTENSION_SECRETS_KEY
    await expect(getCredentialSummary(context())).rejects.toThrow('GCS_EXTENSION_SECRETS_KEY is required')
  })

  it('rejects credentials tagged for a different configured service', async () => {
    await expect(saveCredential(context({
      service: 'backblaze-b2', accessKeyId: 'b2-id', secretAccessKey: 'b2-secret'
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'GCS_STORAGE_S3_SERVICE_MISMATCH'
    })
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('preserves the existing secret when candidate credentials fail their canary', async () => {
    testConnection.mockRejectedValueOnce(new Error('invalid credentials'))
    await expect(saveCredential(context({
      service: 'amazon-s3', accessKeyId: 'replacement', secretAccessKey: 'wrong'
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CONNECTION_FAILED'
    })
    expect(setSecret).not.toHaveBeenCalled()
    expect(destroyClient).toHaveBeenCalledOnce()
  })
})
