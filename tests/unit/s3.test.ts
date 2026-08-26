import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectKey, createS3Client, deleteObject, putObject, readObject, testS3Connection } from '../../server/s3'
import type { S3AgencyConfig } from '../../shared/config'

const config: S3AgencyConfig = { service: 'amazon-s3', bucket: 'bucket', region: 'ca-central-1', keyPrefix: 'agency/17', credentialMode: 'default-chain', encryption: 'bucket-default', forcePathStyle: false }

describe('S3 commands', () => {
  it('builds contained prefixed keys', () => {
    expect(buildObjectKey('agency/17/', 'object')).toBe('agency/17/object')
    expect(() => buildObjectKey('', '../escape')).toThrow('Invalid S3 object name')
  })
  it('uses the validated B2 endpoint and derived signing region', async () => {
    const client = createS3Client({
      service: 'backblaze-b2', bucket: 'bucket', region: 'us-east-005', endpoint: 'https://s3.us-east-005.backblazeb2.com',
      keyPrefix: '', credentialMode: 'agency-secret', encryption: 'bucket-default', forcePathStyle: true
    }, { service: 'backblaze-b2', accessKeyId: 'key-id', secretAccessKey: 'application-key' })
    try {
      await expect(client.config.region()).resolves.toBe('us-east-005')
      await expect(client.config.endpoint!()).resolves.toMatchObject({ hostname: 's3.us-east-005.backblazeb2.com', protocol: 'https:' })
      expect(client.config.forcePathStyle).toBe(true)
    } finally { client.destroy() }
  })
  it('rejects credentials for a different service before creating a client', () => {
    expect(() => createS3Client(config, {
      service: 'backblaze-b2', accessKeyId: 'key-id', secretAccessKey: 'application-key'
    })).toThrow('do not match the configured storage service')
  })
  it('supports a single-attempt client for version-safe writes', async () => {
    const client = createS3Client(config, undefined, { maxAttempts: 1 })
    try { await expect(client.config.maxAttempts()).resolves.toBe(1) } finally { client.destroy() }
  })
  it('puts with bucket-default encryption and optional KMS encryption', async () => {
    const send = vi.fn().mockResolvedValueOnce({ VersionId: 'version-1' }).mockResolvedValueOnce({})
    await expect(putObject({ send: send as never }, config, 'key', new Uint8Array([1]), 'text/plain')).resolves.toBe('version-1')
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand)
    expect((send.mock.calls[0]?.[0] as PutObjectCommand).input).not.toHaveProperty('ServerSideEncryption')
    expect((send.mock.calls[0]?.[0] as PutObjectCommand).input.Metadata?.['gcs-write-token']).toBeTruthy()
    await putObject({ send: send as never }, { ...config, encryption: 'sse-kms', kmsKeyId: 'kms-key' }, 'key', new Uint8Array([1]), 'text/plain')
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'kms-key' })
  })
  it('reads and deletes through AWS commands', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([4, 2]) }, ContentType: 'x/test' }).mockResolvedValueOnce({})
    await expect(readObject({ send: send as never }, config, 'key', 'version-1')).resolves.toEqual({ bytes: new Uint8Array([4, 2]), contentType: 'x/test' })
    await deleteObject({ send: send as never }, config, 'key', 'version-1')
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand)
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input.VersionId).toBe('version-1')
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand)
    expect((send.mock.calls[1]?.[0] as DeleteObjectCommand).input).toMatchObject({ VersionId: 'version-1' })
  })
  it('best-effort removes an ambiguously stored object before rethrowing a PUT failure', async () => {
    const putError = new Error('response lost')
    const send = vi.fn()
      .mockRejectedValueOnce(putError)
      .mockImplementationOnce(async command => ({
        VersionId: 'recovered-version',
        Metadata: { 'gcs-write-token': (send.mock.calls[0]?.[0] as PutObjectCommand).input.Metadata?.['gcs-write-token'] }
      }))
      .mockResolvedValueOnce({})
    await expect(putObject({ send: send as never }, config, 'unique-key', new Uint8Array([1]), 'x/test')).rejects.toBe(putError)
    expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([PutObjectCommand, HeadObjectCommand, DeleteObjectCommand])
    expect((send.mock.calls[2]?.[0] as DeleteObjectCommand).input.VersionId).toBe('recovered-version')
  })
  it('does not delete an object whose ambiguous PUT cannot be tied to this write', async () => {
    const putError = new Error('response lost')
    const send = vi.fn().mockRejectedValueOnce(putError).mockResolvedValueOnce({
      VersionId: 'other-version', Metadata: { 'gcs-write-token': 'another-write' }
    })
    await expect(putObject({ send: send as never }, config, 'key', new Uint8Array([1]), 'x/test')).rejects.toBe(putError)
    expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([PutObjectCommand, HeadObjectCommand])
  })
  it('always deletes its write/read canary', async () => {
    const send = vi.fn(async command => command instanceof PutObjectCommand
      ? { VersionId: 'canary-version' }
      : command instanceof GetObjectCommand
      ? { Body: { transformToByteArray: async () => new TextEncoder().encode('gcs-storage-s3-canary') } }
      : {})
    await testS3Connection({ send: send as never }, config)
    expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([PutObjectCommand, GetObjectCommand, DeleteObjectCommand])
    expect((send.mock.calls[2]?.[0] as DeleteObjectCommand).input.VersionId).toBe('canary-version')
  })
})
