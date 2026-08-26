import { z } from 'zod'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'

export const S3ServiceSchema = z.enum(['amazon-s3', 'backblaze-b2'])
export type S3Service = z.infer<typeof S3ServiceSchema>

const normalizeB2Endpoint = (value: string): string => {
  const withProtocol = value.includes('://') ? value : `https://${value}`
  const endpoint = new URL(withProtocol)
  if (
    endpoint.protocol !== 'https:'
    || !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/i.test(endpoint.hostname)
    || endpoint.username
    || endpoint.password
    || endpoint.port
    || endpoint.pathname !== '/'
    || endpoint.search
    || endpoint.hash
  ) throw new Error('Invalid Backblaze B2 S3 endpoint')
  return endpoint.origin
}

export const deriveB2Region = (endpoint: string): string => {
  const hostname = new URL(normalizeB2Endpoint(endpoint)).hostname
  return hostname.slice(3, -'.backblazeb2.com'.length)
}

export const S3AgencyConfigSchema = z.object({
  service: S3ServiceSchema.default('amazon-s3'),
  bucket: z.string().trim().min(1).max(255),
  region: z.string().trim().max(64).default(''),
  endpoint: z.string().trim().max(2048).optional(),
  keyPrefix: z.string().trim().max(512).default('').refine(value => !value.startsWith('/') && !value.split('/').includes('..')),
  credentialMode: z.enum(['default-chain', 'agency-secret']).default('default-chain'),
  encryption: z.enum(['bucket-default', 'sse-kms']).default('bucket-default'),
  kmsKeyId: z.string().trim().max(2048).optional()
}).superRefine((value, context) => {
  if (value.service === 'amazon-s3' && !value.region) context.addIssue({ code: 'custom', path: ['region'], message: 'AWS region is required.' })
  if (value.service === 'backblaze-b2') {
    if (!value.endpoint) context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Backblaze B2 S3 endpoint is required.' })
    else {
      try { normalizeB2Endpoint(value.endpoint) } catch { context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Invalid Backblaze B2 S3 endpoint.' }) }
    }
    if (value.credentialMode !== 'agency-secret') context.addIssue({ code: 'custom', path: ['credentialMode'], message: 'Backblaze B2 requires agency credentials.' })
    if (value.encryption !== 'bucket-default') context.addIssue({ code: 'custom', path: ['encryption'], message: 'Backblaze B2 does not support AWS SSE-KMS.' })
  }
  if (value.encryption === 'sse-kms' && !value.kmsKeyId) context.addIssue({ code: 'custom', path: ['kmsKeyId'], message: 'KMS key ID is required for SSE-KMS.' })
}).transform(value => value.service === 'backblaze-b2'
  ? { ...value, endpoint: normalizeB2Endpoint(value.endpoint!), region: deriveB2Region(value.endpoint!), forcePathStyle: true }
  : { ...value, forcePathStyle: false })

export type S3AgencyConfig = z.infer<typeof S3AgencyConfigSchema>
export const parseS3AgencyConfig = (config: GcsExtensionJsonConfig): S3AgencyConfig => S3AgencyConfigSchema.parse(config)

export const S3CredentialSchema = z.object({
  service: S3ServiceSchema.default('amazon-s3'),
  accessKeyId: z.string().trim().min(1).max(128),
  secretAccessKey: z.string().min(1).max(4096),
  sessionToken: z.string().max(8192).optional()
})
export type S3Credential = z.infer<typeof S3CredentialSchema>
export const maskAccessKeyId = (value: string): string => value.length <= 4 ? '****' : `${'*'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`

export const storageBackendFingerprint = (config: S3AgencyConfig): string => JSON.stringify({
  service: config.service,
  bucket: config.bucket,
  region: config.region,
  endpoint: config.endpoint ?? null,
  forcePathStyle: config.forcePathStyle
})
