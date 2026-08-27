import {
  defineGcsExtensionRouteHandler,
  type GcsExtensionRouteContext
} from '@gcs-ssc/extensions/server'
import { loadCredential } from '../credentials.ts'
import { createS3Client, testS3Connection } from '../s3.ts'
import {
  parseS3AgencyConfigRequest,
  storageConnectionFailedError,
  storageCredentialsMissingError,
  storageServiceMismatchError
} from '../user-errors.ts'

export const testStorageConnection = async (context: GcsExtensionRouteContext) => {
  const config = parseS3AgencyConfigRequest(await context.readBody())
  const credential = config.credentialMode === 'agency-secret'
    ? (await loadCredential(context.db, context.params.agencyId ?? '') ?? undefined)
    : undefined
  if (config.credentialMode === 'agency-secret' && !credential) throw storageCredentialsMissingError()
  if (credential && credential.service !== config.service) throw storageServiceMismatchError()
  const client = createS3Client(config, credential, { maxAttempts: 1 })
  try {
    try {
      await testS3Connection(client, config)
    } catch {
      throw storageConnectionFailedError()
    }
    return { ok: true }
  } finally {
    client.destroy()
  }
}

export default defineGcsExtensionRouteHandler(testStorageConnection)
