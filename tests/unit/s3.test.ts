import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import {
  buildObjectKey,
  createS3Client,
  deleteObject,
  putObject,
  readObject,
  readObjectVersion,
  resolveS3CanaryTimeoutMs,
  resolveS3OperationTimeoutMs,
  s3CanaryRequestHandlerOptions,
  testS3Connection
} from '../../server/s3'
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
    const client = createS3Client(config, undefined, { maxAttempts: 1, requestTimeoutMs: 750 })
    try {
      await expect(client.config.maxAttempts()).resolves.toBe(1)
      expect(client.config.requestHandler).toBeTruthy()
    } finally { client.destroy() }
  })
  it('retains the standard SDK retry policy for bounded reads and deletes', async () => {
    const client = createS3Client(config, undefined, { requestTimeoutMs: 750 })
    try {
      await expect(client.config.maxAttempts()).resolves.toBe(3)
      expect(client.config.requestHandler).toBeTruthy()
    } finally { client.destroy() }
  })
  it('validates the configurable canary deadline', () => {
    expect(resolveS3CanaryTimeoutMs(undefined)).toBe(5_000)
    expect(resolveS3CanaryTimeoutMs('750')).toBe(750)
    expect(() => resolveS3CanaryTimeoutMs('99')).toThrow('must be an integer from 100 to 60000')
    expect(() => resolveS3CanaryTimeoutMs('not-a-number')).toThrow('must be an integer from 100 to 60000')
    expect(s3CanaryRequestHandlerOptions(750)).toEqual({
      connectionTimeout: 750,
      requestTimeout: 750,
      socketTimeout: 750,
      throwOnRequestTimeout: true
    })
  })
  it('validates the configurable ordinary-operation deadline', () => {
    expect(resolveS3OperationTimeoutMs(undefined)).toBe(60_000)
    expect(resolveS3OperationTimeoutMs('750')).toBe(750)
    expect(() => resolveS3OperationTimeoutMs('99')).toThrow('must be an integer from 100 to 600000')
    expect(() => resolveS3OperationTimeoutMs('600001')).toThrow('must be an integer from 100 to 600000')
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
  it('uses a fresh bounded HEAD deadline and logs one sanitized cleanup event without replacing the PUT error', async () => {
    vi.useFakeTimers()
    const putError = new Error('response lost with secret material')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const send = vi.fn()
        .mockRejectedValueOnce(putError)
        .mockImplementationOnce(() => new Promise(() => {}))
      const pending = putObject({ send: send as never }, config, 'opaque-key', new Uint8Array([1]), 'secret/type', { timeoutMs: 250 })
      const rejection = expect(pending).rejects.toBe(putError)
      await vi.advanceTimersByTimeAsync(250)
      await rejection
      expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([PutObjectCommand, HeadObjectCommand])
      const putSignal = send.mock.calls[0]?.[1]?.abortSignal as AbortSignal
      const headSignal = send.mock.calls[1]?.[1]?.abortSignal as AbortSignal
      expect(headSignal).not.toBe(putSignal)
      expect(headSignal.aborted).toBe(true)
      expect(log).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith('Failed to clean up an ambiguously completed S3 PUT.', {
        category: 'storage_cleanup_failed',
        providerId: 'gcs-storage-s3',
        objectId: 'opaque-key',
        purpose: 'ambiguous_put_recovery',
        phase: 'head'
      })
      expect(JSON.stringify(log.mock.calls)).not.toContain('response lost with secret material')
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret/type')
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })
  it('uses a fresh bounded exact-version DELETE deadline and identifies that cleanup phase', async () => {
    vi.useFakeTimers()
    const putError = new Error('response lost')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const send = vi.fn()
        .mockRejectedValueOnce(putError)
        .mockImplementationOnce(async () => ({
          VersionId: 'recovered-version',
          Metadata: { 'gcs-write-token': (send.mock.calls[0]?.[0] as PutObjectCommand).input.Metadata?.['gcs-write-token'] }
        }))
        .mockImplementationOnce(() => new Promise(() => {}))
      const pending = putObject({ send: send as never }, config, 'opaque-key', new Uint8Array([1]), 'x/test', { timeoutMs: 250 })
      const rejection = expect(pending).rejects.toBe(putError)
      await vi.advanceTimersByTimeAsync(250)
      await rejection
      expect(send.mock.calls.map(call => call[0]?.constructor)).toEqual([PutObjectCommand, HeadObjectCommand, DeleteObjectCommand])
      const headSignal = send.mock.calls[1]?.[1]?.abortSignal as AbortSignal
      const deleteSignal = send.mock.calls[2]?.[1]?.abortSignal as AbortSignal
      expect(deleteSignal).not.toBe(headSignal)
      expect(deleteSignal.aborted).toBe(true)
      expect((send.mock.calls[2]?.[0] as DeleteObjectCommand).input.VersionId).toBe('recovered-version')
      expect(log).toHaveBeenCalledOnce()
      expect(log.mock.calls[0]?.[1]).toMatchObject({ category: 'storage_cleanup_failed', phase: 'delete' })
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })
  it('bounds GET body consumption and destroys the stalled response body', async () => {
    vi.useFakeTimers()
    try {
      const destroy = vi.fn()
      const send = vi.fn().mockResolvedValue({
        Body: { destroy, transformToByteArray: () => new Promise(() => {}) }
      })
      const pending = readObject({ send: send as never }, config, 'key', undefined, { timeoutMs: 250 })
      const rejection = expect(pending).rejects.toThrow('S3 get-body operation timed out')
      await vi.advanceTimersByTimeAsync(250)
      await rejection
      expect(destroy).toHaveBeenCalledOnce()
      expect((send.mock.calls[0]?.[1]?.abortSignal as AbortSignal).aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('bounds stalled HEAD and DELETE operations independently', async () => {
    vi.useFakeTimers()
    try {
      const headSend = vi.fn((_command: unknown, _options?: unknown) => new Promise(() => {}))
      const headPending = readObjectVersion({ send: headSend as never }, config, 'key', { timeoutMs: 250 })
      const headRejection = expect(headPending).rejects.toThrow('S3 head operation timed out')
      await vi.advanceTimersByTimeAsync(250)
      await headRejection
      expect(((headSend.mock.calls[0]?.[1] as { abortSignal: AbortSignal }).abortSignal).aborted).toBe(true)

      const deleteSend = vi.fn((_command: unknown, _options?: unknown) => new Promise(() => {}))
      const deletePending = deleteObject({ send: deleteSend as never }, config, 'key', 'version-1', { timeoutMs: 250 })
      const deleteRejection = expect(deletePending).rejects.toThrow('S3 delete operation timed out')
      await vi.advanceTimersByTimeAsync(250)
      await deleteRejection
      expect(((deleteSend.mock.calls[0]?.[1] as { abortSignal: AbortSignal }).abortSignal).aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
  it('aborts a never-resolving transport at the canary deadline and clears its timer', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(() => new Promise(() => {}))
      const pending = testS3Connection({ send: send as never }, config, { timeoutMs: 250 })
      const rejection = expect(pending).rejects.toBeTruthy()
      await vi.advanceTimersByTimeAsync(250)
      await rejection
      expect(send).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
