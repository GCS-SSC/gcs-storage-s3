import {
  getEncryptedExtensionSecret,
  lockGcsExtensionLifecycleScope,
  setEncryptedExtensionSecret,
  type GcsExtensionRouteContext
} from '@gcs-ssc/extensions/server'
import type { Kysely } from 'kysely'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import { parseS3AgencyConfig, S3CredentialSchema, maskAccessKeyId, type S3Credential } from '../shared/config.ts'
import { createS3Client, testS3Connection } from './s3.ts'

export const EXTENSION_KEY = 'gcs-storage-s3'
export const CREDENTIAL_SECRET_KEY = 'aws-credentials'

interface CredentialConfigurationDatabase {
  'extensions.agency_enablement': {
    id: string
    agency_id: string
    extension_key: string
    config: GcsExtensionJsonConfig
    enabled: boolean
    _deleted: boolean
  }
}

const rootKey = (): string => {
  const value = process.env.GCS_EXTENSION_SECRETS_KEY
  if (!value) throw new Error('GCS_EXTENSION_SECRETS_KEY is required')
  return value
}

const agencyId = (context: GcsExtensionRouteContext): string => {
  const id = context.params.agencyId
  if (!id) throw new Error('Agency identifier is required')
  return id
}

export const loadCredential = async (db: GcsExtensionRouteContext['db'], ownerId: string): Promise<S3Credential | null> => {
  const value = await getEncryptedExtensionSecret(db as never, {
    rootKey: rootKey(), extensionKey: EXTENSION_KEY, ownerType: 'agency', ownerId, secretKey: CREDENTIAL_SECRET_KEY
  })
  return value === null ? null : S3CredentialSchema.parse(value)
}

export const credentialSummary = (credential: S3Credential | null) => credential
  ? { configured: true, accessKeyIdMasked: maskAccessKeyId(credential.accessKeyId), hasSessionToken: Boolean(credential.sessionToken) }
  : { configured: false, accessKeyIdMasked: null, hasSessionToken: false }

export const getCredentialSummary = async (context: GcsExtensionRouteContext) =>
  credentialSummary(await loadCredential(context.db, agencyId(context)))

export const saveCredential = async (context: GcsExtensionRouteContext) => {
  const ownerId = agencyId(context)
  const credential = S3CredentialSchema.parse(await context.readBody())
  const writeAuthorization = context.writeAuthorization
  if (!writeAuthorization) throw new Error('S3 credential writes require host-provided transaction authorization.')
  const database = context.db as {
    transaction: () => { execute: <T>(callback: (trx: unknown) => Promise<T>) => Promise<T> }
  }
  await database.transaction().execute(async trx => {
    await writeAuthorization.lockAuthState(trx)
    await lockGcsExtensionLifecycleScope(trx as never, EXTENSION_KEY, ownerId)
    await (writeAuthorization.authorizeCurrentScope ?? writeAuthorization.authorizeCurrentEntity)(trx)
    const configuration = await (trx as Kysely<CredentialConfigurationDatabase>)
      .selectFrom('extensions.agency_enablement')
      .select(['config', 'enabled'])
      .where('extension_key', '=', EXTENSION_KEY)
      .where('agency_id', '=', ownerId)
      .where('_deleted', '=', false)
      .forUpdate()
      .executeTakeFirst()
    if (!configuration?.enabled) throw new Error('S3 storage must be enabled before credentials can be saved')
    const config = parseS3AgencyConfig(configuration.config)
    if (credential.service !== config.service) throw new Error('S3 credentials do not match the configured storage service')
    const client = createS3Client(config, credential, { maxAttempts: 1 })
    try {
      await testS3Connection(client, config)
    } finally {
      client.destroy()
    }
    await setEncryptedExtensionSecret(trx as never, {
      rootKey: rootKey(), extensionKey: EXTENSION_KEY, ownerType: 'agency', ownerId,
      secretKey: CREDENTIAL_SECRET_KEY, value: credential, metadata: { accessKeyIdMasked: maskAccessKeyId(credential.accessKeyId), hasSessionToken: Boolean(credential.sessionToken) }
    })
  })
  return credentialSummary(credential)
}
