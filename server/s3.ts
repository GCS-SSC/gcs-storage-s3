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

export const createS3Client = (
  config: S3AgencyConfig,
  credential?: S3Credential,
  options: { maxAttempts?: number } = {}
): S3Client => {
  if (credential && credential.service !== config.service) throw new Error('S3 credentials do not match the configured storage service')
  const clientConfig: S3ClientConfig = {
    region: config.region,
    ...(config.service === 'backblaze-b2' ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
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

export const putObject = async (client: S3CommandClient, config: S3AgencyConfig, key: string, bytes: Uint8Array, contentType: string): Promise<string | undefined> => {
  const writeToken = nanoid(24)
  try {
    const response = await client.send(new PutObjectCommand({
      Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { 'gcs-write-token': writeToken },
      ...(config.encryption === 'sse-kms' ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyId } : {})
    })) as { VersionId?: string }
    return response.VersionId
  } catch (error: unknown) {
    try {
      const recovered = await readObjectVersionDetails(client, config, key)
      if (recovered.writeToken === writeToken) await deleteObject(client, config, key, recovered.versionId)
    } catch {
      // The original PUT error remains authoritative; cleanup is best effort.
    }
    throw error
  }
}

export const readObject = async (client: S3CommandClient, config: S3AgencyConfig, key: string, versionId?: string): Promise<{ bytes: Uint8Array, contentType?: string }> => {
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }))
  if (!response.Body) throw new Error('S3 object body is unavailable')
  const bytes = await response.Body.transformToByteArray()
  return { bytes, ...(response.ContentType ? { contentType: response.ContentType } : {}) }
}

export const readObjectVersion = async (client: S3CommandClient, config: S3AgencyConfig, key: string): Promise<string | undefined> => {
  return (await readObjectVersionDetails(client, config, key)).versionId
}

const readObjectVersionDetails = async (
  client: S3CommandClient,
  config: S3AgencyConfig,
  key: string
): Promise<{ versionId?: string, writeToken?: string }> => {
  const response = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })) as {
    VersionId?: string
    Metadata?: Record<string, string>
  }
  return {
    ...(response.VersionId ? { versionId: response.VersionId } : {}),
    ...(response.Metadata?.['gcs-write-token'] ? { writeToken: response.Metadata['gcs-write-token'] } : {})
  }
}

export const deleteObject = async (client: S3CommandClient, config: S3AgencyConfig, key: string, versionId?: string): Promise<void> => {
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }))
}

export const testS3Connection = async (client: S3CommandClient, config: S3AgencyConfig): Promise<void> => {
  const key = buildObjectKey(config.keyPrefix, `.gcs-canary/${Date.now()}-${nanoid(12)}`)
  const expected = new TextEncoder().encode('gcs-storage-s3-canary')
  let versionId: string | undefined
  let wrote = false
  try {
    versionId = await putObject(client, config, key, expected, 'application/octet-stream')
    wrote = true
    const actual = await readObject(client, config, key, versionId)
    if (!Buffer.from(actual.bytes).equals(Buffer.from(expected))) throw new Error('S3 canary read did not match its write')
  } finally {
    if (wrote) await deleteObject(client, config, key, versionId)
  }
}
