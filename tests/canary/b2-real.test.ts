import { describe, expect, it } from 'vitest'
import { createS3Client, testS3Connection } from '../../server/s3'
import { parseS3AgencyConfig } from '../../shared/config'

describe.skipIf(process.env.GCS_B2_REAL_CANARY !== 'true')('real Backblaze B2 canary', () => {
  it('writes, reads, verifies, and deletes through the B2 S3-compatible API', async () => {
    const config = parseS3AgencyConfig({
      service: 'backblaze-b2',
      bucket: process.env.B2_S3_BUCKET ?? '',
      endpoint: process.env.B2_S3_ENDPOINT ?? '',
      keyPrefix: 'gcs-ssc-canary',
      credentialMode: 'agency-secret',
      encryption: 'bucket-default'
    })
    const client = createS3Client(config, {
      service: 'backblaze-b2',
      accessKeyId: process.env.B2_S3_KEY_ID ?? '',
      secretAccessKey: process.env.B2_S3_APPLICATION_KEY ?? ''
    }, { maxAttempts: 1 })
    try { await expect(testS3Connection(client, config)).resolves.toBeUndefined() } finally { client.destroy() }
  })
})
