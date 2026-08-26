import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectKey, deleteObject, putObject, readObject, testS3Connection } from '../../server/s3'
import type { S3AgencyConfig } from '../../shared/config'

const config: S3AgencyConfig = { bucket: 'bucket', region: 'ca-central-1', keyPrefix: 'agency/17', credentialMode: 'default-chain', encryption: 'bucket-default' }

describe('S3 commands', () => {
  it('builds contained prefixed keys', () => {
    expect(buildObjectKey('agency/17/', 'object')).toBe('agency/17/object')
    expect(() => buildObjectKey('', '../escape')).toThrow('Invalid S3 object name')
  })
  it('puts with bucket-default encryption and optional KMS encryption', async () => {
    const send = vi.fn().mockResolvedValue({})
    await putObject({ send: send as never }, config, 'key', new Uint8Array([1]), 'text/plain')
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand)
    expect((send.mock.calls[0]?.[0] as PutObjectCommand).input).not.toHaveProperty('ServerSideEncryption')
    await putObject({ send: send as never }, { ...config, encryption: 'sse-kms', kmsKeyId: 'kms-key' }, 'key', new Uint8Array([1]), 'text/plain')
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'kms-key' })
  })
  it('reads and deletes through AWS commands', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([4, 2]) }, ContentType: 'x/test' }).mockResolvedValueOnce({})
    await expect(readObject({ send: send as never }, config, 'key')).resolves.toEqual({ bytes: new Uint8Array([4, 2]), contentType: 'x/test' })
    await deleteObject({ send: send as never }, config, 'key')
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand)
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand)
  })
  it('always deletes its write/read canary', async () => {
    const send = vi.fn(async command => command instanceof GetObjectCommand
      ? { Body: { transformToByteArray: async () => new TextEncoder().encode('gcs-storage-s3-canary') } }
      : {})
    await testS3Connection({ send: send as never }, config)
    expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([PutObjectCommand, GetObjectCommand, DeleteObjectCommand])
  })
})

