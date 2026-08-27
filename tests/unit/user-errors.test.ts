import { describe, expect, it } from 'vitest'
import {
  parseS3AgencyConfigRequest,
  parseS3CredentialRequest,
  storageConnectionFailedError,
  storageCredentialsMissingError,
  storageProviderDisabledError,
  storageServiceMismatchError
} from '../../server/user-errors'

describe('S3 route user errors', () => {
  it('maps invalid configuration and credentials to structured bilingual errors', () => {
    expect(() => parseS3AgencyConfigRequest({})).toThrow(expect.objectContaining({
      name: 'GcsExtensionUserError',
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CONFIG_INVALID',
      localizedMessage: expect.objectContaining({ en: expect.any(String), fr: expect.any(String) }),
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'bucket', message: expect.objectContaining({ en: expect.any(String), fr: expect.any(String) }) })
      ])
    }))
    expect(() => parseS3CredentialRequest({ accessKeyId: '', secretAccessKey: '' })).toThrow(expect.objectContaining({
      name: 'GcsExtensionUserError',
      statusCode: 400,
      code: 'GCS_STORAGE_S3_CREDENTIALS_INVALID'
    }))
  })

  it('uses stable conflicts for incomplete provider state', () => {
    expect(storageProviderDisabledError()).toMatchObject({ statusCode: 409, code: 'GCS_STORAGE_S3_PROVIDER_DISABLED' })
    expect(storageServiceMismatchError()).toMatchObject({ statusCode: 409, code: 'GCS_STORAGE_S3_SERVICE_MISMATCH' })
    expect(storageCredentialsMissingError()).toMatchObject({ statusCode: 409, code: 'GCS_STORAGE_S3_CREDENTIALS_MISSING' })
  })

  it('hides raw provider failures behind a stable bilingual error', () => {
    const error = storageConnectionFailedError()
    expect(error).toMatchObject({ statusCode: 400, code: 'GCS_STORAGE_S3_CONNECTION_FAILED' })
    expect(error.message).not.toContain('secret')
    expect(error.localizedMessage).toEqual(expect.objectContaining({ en: expect.any(String), fr: expect.any(String) }))
  })
})
