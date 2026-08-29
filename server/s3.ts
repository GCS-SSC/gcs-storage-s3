import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from '@aws-sdk/client-s3'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { nanoid } from 'nanoid'
import type { S3AgencyConfig, S3Credential } from '../shared/config.ts'

export interface S3CommandClient {
  send: S3Client['send']
  destroy?: () => void
}

export const DEFAULT_S3_CANARY_TIMEOUT_MS = 5_000
const MIN_S3_CANARY_TIMEOUT_MS = 100
const MAX_S3_CANARY_TIMEOUT_MS = 60_000
export const DEFAULT_S3_OPERATION_TIMEOUT_MS = 60_000
const MIN_S3_OPERATION_TIMEOUT_MS = 100
const MAX_S3_OPERATION_TIMEOUT_MS = 600_000

interface S3OperationOptions {
  timeoutMs?: number
}

type S3CleanupPhase = 'head' | 'delete'

const withS3OperationDeadline = async <T>(
  phase: 'put' | 'get-body' | 'head' | 'delete',
  timeoutMs: number,
  operation: (abortSignal: AbortSignal) => Promise<T>,
  onTimeout?: () => void
): Promise<T> => {
  const abortController = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`S3 ${phase} operation timed out`)
      reject(error)
      abortController.abort(error)
      try { onTimeout?.() } catch { /* Client destruction remains the adapter's final fallback. */ }
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(abortController.signal), deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const logAmbiguousPutCleanupFailure = (key: string, phase: S3CleanupPhase): void => {
  console.error('Failed to clean up an ambiguously completed S3 PUT.', {
    category: 'storage_cleanup_failed',
    providerId: 'gcs-storage-s3',
    objectId: key,
    purpose: 'ambiguous_put_recovery',
    phase
  })
}

export const resolveS3CanaryTimeoutMs = (value = process.env.GCS_STORAGE_S3_CANARY_TIMEOUT_MS): number => {
  if (value === undefined || value.trim() === '') return DEFAULT_S3_CANARY_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < MIN_S3_CANARY_TIMEOUT_MS || parsed > MAX_S3_CANARY_TIMEOUT_MS) {
    throw new Error(`GCS_STORAGE_S3_CANARY_TIMEOUT_MS must be an integer from ${MIN_S3_CANARY_TIMEOUT_MS} to ${MAX_S3_CANARY_TIMEOUT_MS}`)
  }
  return parsed
}

export const resolveS3OperationTimeoutMs = (value = process.env.GCS_STORAGE_S3_OPERATION_TIMEOUT_MS): number => {
  if (value === undefined || value.trim() === '') return DEFAULT_S3_OPERATION_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < MIN_S3_OPERATION_TIMEOUT_MS || parsed > MAX_S3_OPERATION_TIMEOUT_MS) {
    throw new Error(`GCS_STORAGE_S3_OPERATION_TIMEOUT_MS must be an integer from ${MIN_S3_OPERATION_TIMEOUT_MS} to ${MAX_S3_OPERATION_TIMEOUT_MS}`)
  }
  return parsed
}

export const s3CanaryRequestHandlerOptions = (timeoutMs: number) => ({
  connectionTimeout: timeoutMs,
  requestTimeout: timeoutMs,
  socketTimeout: timeoutMs,
  throwOnRequestTimeout: true
})

export const createS3Client = (
  config: S3AgencyConfig,
  credential?: S3Credential,
  options: { maxAttempts?: number, requestTimeoutMs?: number } = {}
): S3Client => {
  if (credential && credential.service !== config.service) throw new Error('S3 credentials do not match the configured storage service')
  const clientConfig: S3ClientConfig = {
    region: config.region,
    ...(config.service === 'backblaze-b2' ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.requestTimeoutMs === undefined ? {} : {
      requestHandler: s3CanaryRequestHandlerOptions(options.requestTimeoutMs)
    }),
    credentials: credential
      ? { accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey, sessionToken: credential.sessionToken }
      : fromNodeProviderChain()
  }
  return new S3Client(clientConfig)
}

export const buildObjectKey = (prefix: string, objectName: string): string => {
  if (!objectName || objectName.startsWith('/') || objectName.split('/').includes('..')) throw new Error('Invalid S3 object name')
  const normalizedPrefix = prefix.replace(/\/+$/g, '')
  return normalizedPrefix ? `${normalizedPrefix}/${objectName}` : objectName
}

export const putObject = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  options: S3OperationOptions = {}
): Promise<string | undefined> => {
  const timeoutMs = options.timeoutMs ?? resolveS3OperationTimeoutMs()
  const writeToken = nanoid(24)
  try {
    const response = await withS3OperationDeadline('put', timeoutMs, async abortSignal => {
      return await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { 'gcs-write-token': writeToken },
        ...(config.encryption === 'sse-kms' ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyId } : {})
      }), { abortSignal }) as { VersionId?: string }
    })
    return response.VersionId
  } catch (error: unknown) {
    let cleanupPhase: S3CleanupPhase = 'head'
    try {
      const recovered = await readObjectVersionDetails(client, config, key, { timeoutMs })
      if (recovered.writeToken === writeToken) {
        cleanupPhase = 'delete'
        await deleteObject(client, config, key, recovered.versionId, { timeoutMs })
      }
    } catch {
      logAmbiguousPutCleanupFailure(key, cleanupPhase)
    }
    throw error
  }
}

export const readObject = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  key: string,
  versionId?: string,
  options: S3OperationOptions = {}
): Promise<{ bytes: Uint8Array, contentType?: string }> => {
  const timeoutMs = options.timeoutMs ?? resolveS3OperationTimeoutMs()
  let bodyToDestroy: { destroy?: () => void } | undefined
  return await withS3OperationDeadline('get-body', timeoutMs, async abortSignal => {
    const response = await client.send(new GetObjectCommand({
      Bucket: config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {})
    }), { abortSignal })
    if (!response.Body) throw new Error('S3 object body is unavailable')
    bodyToDestroy = response.Body as typeof bodyToDestroy
    const bytes = await response.Body.transformToByteArray()
    return { bytes, ...(response.ContentType ? { contentType: response.ContentType } : {}) }
  }, () => bodyToDestroy?.destroy?.())
}

export const readObjectVersion = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  key: string,
  options: S3OperationOptions = {}
): Promise<string | undefined> => {
  return (await readObjectVersionDetails(client, config, key, options)).versionId
}

const readObjectVersionDetails = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  key: string,
  options: S3OperationOptions = {}
): Promise<{ versionId?: string, writeToken?: string }> => {
  const timeoutMs = options.timeoutMs ?? resolveS3OperationTimeoutMs()
  const response = await withS3OperationDeadline('head', timeoutMs, async abortSignal => {
    return await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal }) as {
      VersionId?: string
      Metadata?: Record<string, string>
    }
  })
  return {
    ...(response.VersionId ? { versionId: response.VersionId } : {}),
    ...(response.Metadata?.['gcs-write-token'] ? { writeToken: response.Metadata['gcs-write-token'] } : {})
  }
}

export const deleteObject = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  key: string,
  versionId?: string,
  options: S3OperationOptions = {}
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? resolveS3OperationTimeoutMs()
  await withS3OperationDeadline('delete', timeoutMs, async abortSignal => {
    await client.send(new DeleteObjectCommand({
      Bucket: config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {})
    }), { abortSignal })
  })
}

export const testS3Connection = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  options: { timeoutMs?: number } = {}
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? resolveS3CanaryTimeoutMs()
  const abortController = new AbortController()
  const key = buildObjectKey(config.keyPrefix, `.gcs-canary/${Date.now()}-${nanoid(12)}`)
  const expected = new TextEncoder().encode('gcs-storage-s3-canary')
  const executeCanary = async (): Promise<void> => {
    let versionId: string | undefined
    let wrote = false
    try {
      versionId = await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: expected, ContentType: 'application/octet-stream'
      }), { abortSignal: abortController.signal }).then(response => response.VersionId)
      wrote = true
      const response = await client.send(new GetObjectCommand({
        Bucket: config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {})
      }), { abortSignal: abortController.signal })
      if (!response.Body) throw new Error('S3 object body is unavailable')
      const actual = await response.Body.transformToByteArray()
      if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error('S3 canary read did not match its write')
    } finally {
      if (wrote) {
        await client.send(new DeleteObjectCommand({
          Bucket: config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {})
        }), { abortSignal: abortController.signal })
      }
    }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortController.abort()
      reject(new Error('S3 connection canary timed out'))
    }, timeoutMs)
  })
  try {
    await Promise.race([executeCanary(), deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
