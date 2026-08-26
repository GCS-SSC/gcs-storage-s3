import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from '@aws-sdk/client-s3'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { nanoid } from 'nanoid'
import type { S3AgencyConfig, S3Credential } from '../shared/config'

export interface S3CommandClient {
  send: S3Client['send']
  destroy?: () => void
}

export const createS3Client = (
  config: S3AgencyConfig,
  credential?: S3Credential
): S3Client => {
  const clientConfig: S3ClientConfig = {
    region: config.region,
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

export const putObject = async (client: S3CommandClient, config: S3AgencyConfig, key: string, bytes: Uint8Array, contentType: string): Promise<void> => {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType,
    ...(config.encryption === 'sse-kms' ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyId } : {})
  }))
}

export const readObject = async (client: S3CommandClient, config: S3AgencyConfig, key: string): Promise<{ bytes: Uint8Array, contentType?: string }> => {
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  if (!response.Body) throw new Error('S3 object body is unavailable')
  const bytes = await response.Body.transformToByteArray()
  return { bytes, ...(response.ContentType ? { contentType: response.ContentType } : {}) }
}

export const deleteObject = async (client: S3CommandClient, config: S3AgencyConfig, key: string): Promise<void> => {
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
}

export const testS3Connection = async (client: S3CommandClient, config: S3AgencyConfig): Promise<void> => {
  const key = buildObjectKey(config.keyPrefix, `.gcs-canary/${Date.now()}-${nanoid(12)}`)
  const expected = new TextEncoder().encode('gcs-storage-s3-canary')
  try {
    await putObject(client, config, key, expected, 'application/octet-stream')
    const actual = await readObject(client, config, key)
    if (!Buffer.from(actual.bytes).equals(Buffer.from(expected))) throw new Error('S3 canary read did not match its write')
  } finally {
    await deleteObject(client, config, key)
  }
}
