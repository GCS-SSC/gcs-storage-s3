import {
  defineGcsExtensionRouteHandler,
  type GcsExtensionRouteContext
} from '@gcs-ssc/extensions/server'
import { loadCredential, withLockedS3Configuration } from '../credentials.ts'
import { createS3Client, resolveS3CanaryTimeoutMs, testS3Connection } from '../s3.ts'
import {
  storageConnectionFailedError,
  storageCredentialsMissingError,
  storageServiceMismatchError
} from '../user-errors.ts'

export const testStorageConnection = async (context: GcsExtensionRouteContext) => {
  return await withLockedS3Configuration(context, async (config, trx, ownerId) => {
    const credential = config.credentialMode === 'agency-secret'
      ? (await loadCredential(trx as never, ownerId) ?? undefined)
      : undefined
    if (config.credentialMode === 'agency-secret' && !credential) throw storageCredentialsMissingError()
    if (credential && credential.service !== config.service) throw storageServiceMismatchError()
    const timeoutMs = resolveS3CanaryTimeoutMs()
    const client = createS3Client(config, credential, { maxAttempts: 1, requestTimeoutMs: timeoutMs })
    try {
      try {
        await testS3Connection(client, config, { timeoutMs })
      } catch {
        throw storageConnectionFailedError()
      }
      return { ok: true }
    } finally {
      client.destroy()
    }
  })
}

export default defineGcsExtensionRouteHandler(testStorageConnection)
