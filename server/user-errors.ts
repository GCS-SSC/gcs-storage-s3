import {
  createGcsExtensionUserError,
  type GcsExtensionUserError
} from '@gcs-ssc/extensions/server'
import {
  S3AgencyConfigSchema,
  S3CredentialSchema,
  type S3AgencyConfig,
  type S3Credential
} from '../shared/config.ts'

import { userErrorMessage } from '../i18n/user-errors.ts'

type ValidationIssue = {
  code: string
  path: PropertyKey[]
}

const validationDetails = (issues: ValidationIssue[]) => issues.map(issue => ({
  path: issue.path.map(String).join('.') || 'request',
  code: `GCS_STORAGE_S3_${issue.code.toUpperCase()}`,
  message: userErrorMessage('invalidField')
}))

export const parseS3AgencyConfigRequest = (value: unknown): S3AgencyConfig => {
  const parsed = S3AgencyConfigSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw createGcsExtensionUserError({
    code: 'GCS_STORAGE_S3_CONFIG_INVALID',
    message: userErrorMessage('invalidConfiguration'),
    details: validationDetails(parsed.error.issues)
  })
}

export const parseS3CredentialRequest = (value: unknown): S3Credential => {
  const parsed = S3CredentialSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw createGcsExtensionUserError({
    code: 'GCS_STORAGE_S3_CREDENTIALS_INVALID',
    message: userErrorMessage('invalidCredentials'),
    details: validationDetails(parsed.error.issues)
  })
}

const conflict = (
  code: string,
  message: ReturnType<typeof userErrorMessage>
): GcsExtensionUserError => createGcsExtensionUserError({ statusCode: 409, code, message })

export const storageProviderDisabledError = (): GcsExtensionUserError =>
  conflict('GCS_STORAGE_S3_PROVIDER_DISABLED', userErrorMessage('providerDisabled'))

export const storageServiceMismatchError = (): GcsExtensionUserError =>
  conflict('GCS_STORAGE_S3_SERVICE_MISMATCH', userErrorMessage('serviceMismatch'))

export const storageCredentialsMissingError = (): GcsExtensionUserError =>
  conflict('GCS_STORAGE_S3_CREDENTIALS_MISSING', userErrorMessage('credentialsMissing'))

export const storageConnectionFailedError = (): GcsExtensionUserError => createGcsExtensionUserError({
  code: 'GCS_STORAGE_S3_CONNECTION_FAILED',
  message: userErrorMessage('connectionFailed')
})
