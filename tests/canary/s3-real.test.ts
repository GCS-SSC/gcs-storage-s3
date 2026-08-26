import { describe, expect, it } from 'vitest'
import { createS3Client, testS3Connection } from '../../server/s3'
import { parseS3AgencyConfig } from '../../shared/config'

describe.skipIf(process.env.GCS_S3_REAL_CANARY !== 'true')('real S3 canary', () => {
  it('writes, reads, and deletes a canary with the default credential chain', async () => {
    const config = parseS3AgencyConfig({ bucket: process.env.GCS_S3_CANARY_BUCKET ?? '', region: process.env.AWS_REGION ?? '', keyPrefix: 'gcs-ssc-canary', credentialMode: 'default-chain', encryption: 'bucket-default' })
    const client = createS3Client(config)
    try { await expect(testS3Connection(client, config)).resolves.toBeUndefined() } finally { client.destroy() }
  })
})

