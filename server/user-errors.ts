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

const messages = {
  invalidConfiguration: {
    en: 'Enter a valid storage service, bucket, region, endpoint, credential mode, and encryption configuration.',
    fr: 'Saisissez un service de stockage, un compartiment, une région, un point de terminaison, un mode d’identification et une configuration de chiffrement valides.'
  },
  invalidCredentials: {
    en: 'Enter a valid access key ID and secret access key.',
    fr: 'Saisissez un ID de clé d’accès et une clé d’accès secrète valides.'
  },
  invalidField: {
    en: 'Enter a valid value.',
    fr: 'Saisissez une valeur valide.'
  },
  providerDisabled: {
    en: 'Enable and configure S3 storage before saving credentials.',
    fr: 'Activez et configurez le stockage S3 avant d’enregistrer les identifiants.'
  },
  serviceMismatch: {
    en: 'Save credentials for the storage service selected in the agency configuration.',
    fr: 'Enregistrez les identifiants du service de stockage sélectionné dans la configuration de l’agence.'
  },
  credentialsMissing: {
    en: 'Save agency storage credentials before testing this connection.',
    fr: 'Enregistrez les identifiants de stockage de l’agence avant de tester cette connexion.'
  },
  connectionFailed: {
    en: 'The storage connection test failed. Verify the configuration, credentials, permissions, and network access.',
    fr: 'Le test de connexion au stockage a échoué. Vérifiez la configuration, les identifiants, les autorisations et l’accès au réseau.'
  }
} as const

type ValidationIssue = {
  code: string
  path: PropertyKey[]
}

const validationDetails = (issues: ValidationIssue[]) => issues.map(issue => ({
  path: issue.path.map(String).join('.') || 'request',
  code: `GCS_STORAGE_S3_${issue.code.toUpperCase()}`,
  message: messages.invalidField
}))

export const parseS3AgencyConfigRequest = (value: unknown): S3AgencyConfig => {
  const parsed = S3AgencyConfigSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw createGcsExtensionUserError({
    code: 'GCS_STORAGE_S3_CONFIG_INVALID',
    message: messages.invalidConfiguration,
    details: validationDetails(parsed.error.issues)
  })
}

export const parseS3CredentialRequest = (value: unknown): S3Credential => {
  const parsed = S3CredentialSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw createGcsExtensionUserError({
    code: 'GCS_STORAGE_S3_CREDENTIALS_INVALID',
    message: messages.invalidCredentials,
    details: validationDetails(parsed.error.issues)
  })
}

const conflict = (
  code: string,
  message: (typeof messages)[keyof typeof messages]
): GcsExtensionUserError => createGcsExtensionUserError({ statusCode: 409, code, message })

export const storageProviderDisabledError = (): GcsExtensionUserError =>
  conflict('GCS_STORAGE_S3_PROVIDER_DISABLED', messages.providerDisabled)

export const storageServiceMismatchError = (): GcsExtensionUserError =>
  conflict('GCS_STORAGE_S3_SERVICE_MISMATCH', messages.serviceMismatch)

export const storageCredentialsMissingError = (): GcsExtensionUserError =>
  conflict('GCS_STORAGE_S3_CREDENTIALS_MISSING', messages.credentialsMissing)

export const storageConnectionFailedError = (): GcsExtensionUserError => createGcsExtensionUserError({
  code: 'GCS_STORAGE_S3_CONNECTION_FAILED',
  message: messages.connectionFailed
})
