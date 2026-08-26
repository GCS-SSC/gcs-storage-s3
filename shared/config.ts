import { z } from 'zod'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'

export const S3AgencyConfigSchema = z.object({
  bucket: z.string().trim().min(1).max(255),
  region: z.string().trim().min(1).max(64),
  keyPrefix: z.string().trim().max(512).default('').refine(value => !value.startsWith('/') && !value.split('/').includes('..')),
  credentialMode: z.enum(['default-chain', 'agency-secret']).default('default-chain'),
  encryption: z.enum(['bucket-default', 'sse-kms']).default('bucket-default'),
  kmsKeyId: z.string().trim().max(2048).optional()
}).superRefine((value, context) => {
  if (value.encryption === 'sse-kms' && !value.kmsKeyId) context.addIssue({ code: 'custom', path: ['kmsKeyId'], message: 'KMS key ID is required for SSE-KMS.' })
})

export type S3AgencyConfig = z.infer<typeof S3AgencyConfigSchema>
export const parseS3AgencyConfig = (config: GcsExtensionJsonConfig): S3AgencyConfig => S3AgencyConfigSchema.parse(config)

export const S3CredentialSchema = z.object({ accessKeyId: z.string().trim().min(1).max(128), secretAccessKey: z.string().min(1).max(4096), sessionToken: z.string().max(8192).optional() })
export type S3Credential = z.infer<typeof S3CredentialSchema>
export const maskAccessKeyId = (value: string): string => value.length <= 4 ? '****' : `${'*'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`

