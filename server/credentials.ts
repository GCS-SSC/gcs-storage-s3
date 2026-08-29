import {
  getEncryptedExtensionSecret,
  lockGcsExtensionLifecycleScope,
  setEncryptedExtensionSecret,
  type GcsExtensionRouteContext
} from '@gcs-ssc/extensions/server'
import type { Kysely } from 'kysely'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import { S3CredentialSchema, maskAccessKeyId, type S3Credential } from '../shared/config.ts'
import { createS3Client, resolveS3CanaryTimeoutMs, testS3Connection } from './s3.ts'
import {
  parseS3AgencyConfigRequest,
  parseS3CredentialRequest,
  storageConnectionFailedError,
  storageProviderDisabledError,
  storageServiceMismatchError
} from './user-errors.ts'

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

type LockedS3ConfigurationCallback<T> = (
  config: ReturnType<typeof parseS3AgencyConfigRequest>,
  trx: Kysely<CredentialConfigurationDatabase>,
  ownerId: string
) => Promise<T>

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

/** Runs an agency S3 operation against one freshly authorized, locked configuration snapshot. */
export const withLockedS3Configuration = async <T>(
  context: GcsExtensionRouteContext,
  callback: LockedS3ConfigurationCallback<T>
): Promise<T> => {
  const ownerId = agencyId(context)
  const writeAuthorization = context.writeAuthorization
  if (!writeAuthorization) throw new Error('S3 configuration writes require host-provided transaction authorization.')
  const database = context.db as {
    transaction: () => { execute: <R>(operation: (trx: unknown) => Promise<R>) => Promise<R> }
  }
  return await database.transaction().execute(async rawTrx => {
    const trx = rawTrx as Kysely<CredentialConfigurationDatabase>
    await writeAuthorization.lockAuthState(trx)
    await lockGcsExtensionLifecycleScope(trx as never, EXTENSION_KEY, ownerId)
    await (writeAuthorization.authorizeCurrentScope ?? writeAuthorization.authorizeCurrentEntity)(trx)
    const configuration = await trx
      .selectFrom('extensions.agency_enablement')
      .select(['config', 'enabled'])
      .where('extension_key', '=', EXTENSION_KEY)
      .where('agency_id', '=', ownerId)
      .where('_deleted', '=', false)
      .forUpdate()
      .executeTakeFirst()
    if (!configuration?.enabled) throw storageProviderDisabledError()
    return await callback(parseS3AgencyConfigRequest(configuration.config), trx, ownerId)
  })
}

export const saveCredential = async (context: GcsExtensionRouteContext) => {
  const credential = parseS3CredentialRequest(await context.readBody())
  await withLockedS3Configuration(context, async (config, trx, ownerId) => {
    if (credential.service !== config.service) throw storageServiceMismatchError()
    const timeoutMs = resolveS3CanaryTimeoutMs()
    const client = createS3Client(config, credential, { maxAttempts: 1, requestTimeoutMs: timeoutMs })
    try {
      try {
        await testS3Connection(client, config, { timeoutMs })
      } catch {
        throw storageConnectionFailedError()
      }
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
