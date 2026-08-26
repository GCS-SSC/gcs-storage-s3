import { defineGcsFileStorageProviderAdapter, type GcsFileStorageOperationContext, type GcsFileStorageProviderAdapterBase } from '@gcs-ssc/extensions/server'
import { parseS3AgencyConfig, S3CredentialSchema, type S3Credential } from '../shared/config'
import { buildObjectKey, createS3Client, deleteObject, putObject, readObject, type S3CommandClient } from './s3'

export const createStorageAdapter = (dependencies: {
  createClient?: typeof createS3Client
} = {}): GcsFileStorageProviderAdapterBase => {
  const clientFactory = dependencies.createClient ?? createS3Client

  const context = async (input: Pick<GcsFileStorageOperationContext, 'agencyId' | 'agencyConfig' | 'secrets'>) => {
    const config = parseS3AgencyConfig(input.agencyConfig)
    const secret = config.credentialMode === 'agency-secret' ? await input.secrets.get('aws-credentials') : null
    const credential: S3Credential | undefined = secret === null ? undefined : S3CredentialSchema.parse(secret)
    if (config.credentialMode === 'agency-secret' && !credential) throw new Error('Agency S3 credentials are unavailable')
    return { config, credential }
  }
  const locatorKey = (input: Pick<GcsFileStorageOperationContext, 'objectId' | 'locator'>): string => {
    const key = input.locator.key
    if (typeof key !== 'string' || !key || key !== input.objectId) throw new Error('Invalid S3 storage object locator')
    return key
  }
  const storedConfig = (
    config: ReturnType<typeof parseS3AgencyConfig>,
    input: Pick<GcsFileStorageOperationContext, 'locator'>
  ): ReturnType<typeof parseS3AgencyConfig> => {
    const bucket = input.locator.bucket
    const region = input.locator.region
    if (typeof bucket !== 'string' || bucket.length === 0 || typeof region !== 'string' || region.length === 0) {
      throw new Error('Invalid S3 storage object locator')
    }
    return { ...config, bucket, region }
  }

  return {
    validateAgencyConfig: config => parseS3AgencyConfig(config),
    writeObject: async input => {
      const { config, credential } = await context(input)
      const client = clientFactory(config, credential) as S3CommandClient
      const key = buildObjectKey(config.keyPrefix, input.objectName)
      try { await putObject(client, config, key, input.bytes, input.contentType) } finally { client.destroy?.() }
      return { objectId: key, locator: { key, bucket: config.bucket, region: config.region } }
    },
    readObject: async input => {
      const resolved = await context(input)
      const config = storedConfig(resolved.config, input)
      const client = clientFactory(config, resolved.credential) as S3CommandClient
      try { return await readObject(client, config, locatorKey(input)) } finally { client.destroy?.() }
    },
    deleteObject: async input => {
      const resolved = await context(input)
      const config = storedConfig(resolved.config, input)
      const client = clientFactory(config, resolved.credential) as S3CommandClient
      try { await deleteObject(client, config, locatorKey(input)) } finally { client.destroy?.() }
    }
  }
}

export default defineGcsFileStorageProviderAdapter(createStorageAdapter())
