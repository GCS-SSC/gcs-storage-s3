import { describe, expect, it } from 'vitest'
import { deriveB2Region, maskAccessKeyId, parseS3AgencyConfig, S3CredentialSchema } from '../../shared/config'

describe('S3 agency configuration', () => {
  it('normalizes safe defaults', () => {
    expect(parseS3AgencyConfig({ bucket: 'private', region: 'ca-central-1' })).toEqual({
      service: 'amazon-s3', bucket: 'private', region: 'ca-central-1', keyPrefix: '', credentialMode: 'default-chain', encryption: 'bucket-default', forcePathStyle: false
    })
  })
  it('normalizes a Backblaze endpoint and derives its signing region', () => {
    expect(parseS3AgencyConfig({
      service: 'backblaze-b2', bucket: 'private', endpoint: 's3.us-east-005.backblazeb2.com',
      credentialMode: 'agency-secret', encryption: 'bucket-default'
    })).toEqual({
      service: 'backblaze-b2', bucket: 'private', endpoint: 'https://s3.us-east-005.backblazeb2.com',
      region: 'us-east-005', keyPrefix: '', credentialMode: 'agency-secret', encryption: 'bucket-default', forcePathStyle: true
    })
    expect(deriveB2Region('https://s3.eu-central-003.backblazeb2.com')).toBe('eu-central-003')
  })
  it('rejects unsafe endpoints and AWS-only B2 settings', () => {
    const base = { service: 'backblaze-b2', bucket: 'b', credentialMode: 'agency-secret', encryption: 'bucket-default' }
    for (const endpoint of [
      'http://s3.us-east-005.backblazeb2.com',
      'https://s3.us-east-005.backblazeb2.com.evil.example',
      'https://user:secret@s3.us-east-005.backblazeb2.com',
      'https://s3.us-east-005.backblazeb2.com/path',
      'https://127.0.0.1'
    ]) expect(() => parseS3AgencyConfig({ ...base, endpoint })).toThrow()
    expect(() => parseS3AgencyConfig({ ...base, endpoint: 's3.us-east-005.backblazeb2.com', credentialMode: 'default-chain' })).toThrow()
    expect(() => parseS3AgencyConfig({ ...base, endpoint: 's3.us-east-005.backblazeb2.com', encryption: 'sse-kms', kmsKeyId: 'key' })).toThrow()
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
