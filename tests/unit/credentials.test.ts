import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSecret = vi.fn()
const setSecret = vi.fn()
const lockLifecycle = vi.fn()
vi.mock('@gcs-ssc/extensions/server', async importOriginal => ({
  ...await importOriginal<typeof import('@gcs-ssc/extensions/server')>(),
  getEncryptedExtensionSecret: getSecret,
  setEncryptedExtensionSecret: setSecret
  , lockGcsExtensionLifecycleScope: lockLifecycle
}))

const { getCredentialSummary, saveCredential } = await import('../../server/credentials')

const transactionDb = { marker: 'trx' }
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
    const result = await saveCredential(context({ accessKeyId: 'AKIA12345678', secretAccessKey: 'private' }))
    expect(result).toEqual({ configured: true, accessKeyIdMasked: '********5678', hasSessionToken: false })
    expect(lockLifecycle).toHaveBeenCalledWith(transactionDb, 'gcs-storage-s3', '17')
    expect(setSecret).toHaveBeenCalledWith(transactionDb, expect.objectContaining({
      extensionKey: 'gcs-storage-s3', ownerType: 'agency', ownerId: '17', secretKey: 'aws-credentials',
      value: { accessKeyId: 'AKIA12345678', secretAccessKey: 'private' },
      metadata: { accessKeyIdMasked: '********5678', hasSessionToken: false }
    }))
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('fails closed without the host encryption root key', async () => {
    delete process.env.GCS_EXTENSION_SECRETS_KEY
    await expect(getCredentialSummary(context())).rejects.toThrow('GCS_EXTENSION_SECRETS_KEY is required')
  })
})
