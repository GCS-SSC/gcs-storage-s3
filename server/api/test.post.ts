import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { loadCredential } from '../credentials.ts'
import { parseS3AgencyConfig } from '../../shared/config.ts'
import { createS3Client, testS3Connection } from '../s3.ts'

export default defineGcsExtensionRouteHandler(async context => {
  const config = parseS3AgencyConfig(await context.readBody())
  const credential = config.credentialMode === 'agency-secret'
    ? (await loadCredential(context.db, context.params.agencyId ?? '') ?? undefined)
    : undefined
  if (config.credentialMode === 'agency-secret' && !credential) throw new Error('Agency S3 credentials are unavailable')
  const client = createS3Client(config, credential, { maxAttempts: 1 })
  try {
    await testS3Connection(client, config)
    return { ok: true }
  } finally {
    client.destroy()
  }
})
