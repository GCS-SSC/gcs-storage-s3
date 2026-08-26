import {
  getEncryptedExtensionSecret,
  lockGcsExtensionLifecycleScope,
  setEncryptedExtensionSecret,
  type GcsExtensionRouteContext
} from '@gcs-ssc/extensions/server'
import { S3CredentialSchema, maskAccessKeyId, type S3Credential } from '../shared/config'

export const EXTENSION_KEY = 'gcs-storage-s3'
export const CREDENTIAL_SECRET_KEY = 'aws-credentials'

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
    await setEncryptedExtensionSecret(trx as never, {
      rootKey: rootKey(), extensionKey: EXTENSION_KEY, ownerType: 'agency', ownerId,
      secretKey: CREDENTIAL_SECRET_KEY, value: credential, metadata: { accessKeyIdMasked: maskAccessKeyId(credential.accessKeyId), hasSessionToken: Boolean(credential.sessionToken) }
    })
  })
  return credentialSummary(credential)
}
