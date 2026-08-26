import { describe, expect, it } from 'vitest'
import { maskAccessKeyId, parseS3AgencyConfig, S3CredentialSchema } from '../../shared/config'

describe('S3 agency configuration', () => {
  it('normalizes safe defaults', () => {
    expect(parseS3AgencyConfig({ bucket: 'private', region: 'ca-central-1' })).toEqual({
      bucket: 'private', region: 'ca-central-1', keyPrefix: '', credentialMode: 'default-chain', encryption: 'bucket-default'
    })
  })
  it('requires a KMS key and rejects unsafe prefixes', () => {
    expect(() => parseS3AgencyConfig({ bucket: 'b', region: 'r', encryption: 'sse-kms' })).toThrow()
    expect(() => parseS3AgencyConfig({ bucket: 'b', region: 'r', keyPrefix: '../escape' })).toThrow()
  })
  it('validates and masks explicit credentials', () => {
    expect(S3CredentialSchema.parse({ accessKeyId: 'AKIA12345678', secretAccessKey: 'secret' })).toBeTruthy()
    expect(maskAccessKeyId('AKIA12345678')).toBe('********5678')
    expect(maskAccessKeyId('AB')).toBe('****')
  })
})

