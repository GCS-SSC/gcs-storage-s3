import { defineGcsFileStorageProviderAdapter, type GcsFileStorageOperationContext, type GcsFileStorageProviderAdapterBase } from '@gcs-ssc/extensions/server'
import { parseS3AgencyConfig, S3CredentialSchema, type S3Credential } from '../shared/config.ts'
import { buildObjectKey, createS3Client, deleteObject, putObject, readObject, readObjectVersion, type S3CommandClient } from './s3.ts'

export const createStorageAdapter = (dependencies: {
  createClient?: typeof createS3Client
} = {}): GcsFileStorageProviderAdapterBase => {
  const clientFactory = dependencies.createClient ?? createS3Client

  const resolveCredential = async (
    config: ReturnType<typeof parseS3AgencyConfig>,
    secrets: Pick<GcsFileStorageOperationContext, 'secrets'>['secrets']
  ) => {
    const secret = config.credentialMode === 'agency-secret' ? await secrets.get('aws-credentials') : null
    const credential: S3Credential | undefined = secret === null ? undefined : S3CredentialSchema.parse(secret)
    if (config.credentialMode === 'agency-secret' && !credential) throw new Error('Agency S3 credentials are unavailable')
    if (credential && credential.service !== config.service) throw new Error('Agency S3 credentials do not match the configured storage service')
    return { config, credential }
  }
  const locatorKey = (input: Pick<GcsFileStorageOperationContext, 'objectId' | 'locator'>): string => {
    const key = input.locator.key
    if (typeof key !== 'string' || !key || key !== input.objectId) throw new Error('Invalid S3 storage object locator')
    return key
  }
  const locatorVersionId = (input: Pick<GcsFileStorageOperationContext, 'locator'>): string | undefined => {
    const versionId = input.locator.versionId
    if (versionId !== undefined && (typeof versionId !== 'string' || !versionId)) throw new Error('Invalid S3 storage object locator')
    return versionId
  }
  const storedConfig = (
    config: ReturnType<typeof parseS3AgencyConfig>,
    input: Pick<GcsFileStorageOperationContext, 'locator'>
  ): ReturnType<typeof parseS3AgencyConfig> => {
    const bucket = input.locator.bucket
    const region = input.locator.region
    const service = input.locator.service ?? 'amazon-s3'
    const endpoint = input.locator.endpoint
    const forcePathStyle = input.locator.forcePathStyle ?? false
    if (typeof bucket !== 'string' || bucket.length === 0 || typeof region !== 'string' || region.length === 0) {
      throw new Error('Invalid S3 storage object locator')
    }
    if (service !== 'amazon-s3' && service !== 'backblaze-b2') throw new Error('Invalid S3 storage object locator')
    if (
      service !== config.service
      || bucket !== config.bucket
      || region !== config.region
      || endpoint !== config.endpoint
      || forcePathStyle !== config.forcePathStyle
    ) throw new Error('Stored S3 object backend does not match the configured storage backend')
    const stored = {
      ...config,
      service,
      bucket,
      region,
      forcePathStyle,
      credentialMode: service === 'backblaze-b2' ? 'agency-secret' : config.credentialMode,
      encryption: service === 'backblaze-b2' ? 'bucket-default' : config.encryption,
      ...(service === 'backblaze-b2' ? { endpoint } : {})
    }
    if (service === 'amazon-s3') delete stored.endpoint
    return parseS3AgencyConfig(stored)
  }

  return {
    validateAgencyConfig: config => parseS3AgencyConfig(config),
    writeObject: async input => {
      const config = parseS3AgencyConfig(input.agencyConfig)
      const { credential } = await resolveCredential(config, input.secrets)
      const client = clientFactory(config, credential, { maxAttempts: 1 }) as S3CommandClient
      const key = buildObjectKey(config.keyPrefix, input.objectName)
      let versionId: string | undefined
      try { versionId = await putObject(client, config, key, input.bytes, input.contentType) } finally { client.destroy?.() }
      return {
        objectId: key,
        locator: {
          key,
          bucket: config.bucket,
          region: config.region,
          service: config.service,
          forcePathStyle: config.forcePathStyle,
          ...(versionId ? { versionId } : {}),
          ...(config.service === 'backblaze-b2' ? { endpoint: config.endpoint } : {})
        }
      }
    },
    readObject: async input => {
      const config = storedConfig(parseS3AgencyConfig(input.agencyConfig), input)
      const { credential } = await resolveCredential(config, input.secrets)
      const client = clientFactory(config, credential) as S3CommandClient
      try { return await readObject(client, config, locatorKey(input), locatorVersionId(input)) } finally { client.destroy?.() }
    },
    deleteObject: async input => {
      const config = storedConfig(parseS3AgencyConfig(input.agencyConfig), input)
      const { credential } = await resolveCredential(config, input.secrets)
      const client = clientFactory(config, credential) as S3CommandClient
      try {
        const key = locatorKey(input)
        const recordedVersionId = locatorVersionId(input)
        const versionId = recordedVersionId ?? await readObjectVersion(client, config, key)
        await deleteObject(client, config, key, versionId)
      } finally { client.destroy?.() }
    }
  }
}

export default defineGcsFileStorageProviderAdapter(createStorageAdapter())
