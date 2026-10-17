import { defineGcsExtensionMessages, translateGcsExtensionMessage } from '@gcs-ssc/extensions'

export const userErrorMessages = defineGcsExtensionMessages({
  en: {
    "invalidConfiguration": "Enter a valid storage service, bucket, region, endpoint, credential mode, and encryption configuration.",
    "invalidCredentials": "Enter a valid access key ID and secret access key.",
    "invalidField": "Enter a valid value.",
    "providerDisabled": "Enable and configure S3 storage before saving credentials.",
    "serviceMismatch": "Save credentials for the storage service selected in the agency configuration.",
    "credentialsMissing": "Save agency storage credentials before testing this connection.",
    "connectionFailed": "The storage connection test failed. Verify the configuration, credentials, permissions, and network access."
},
  fr: {
    "invalidConfiguration": "Saisissez un service de stockage, un compartiment, une région, un point de terminaison, un mode d’identification et une configuration de chiffrement valides.",
    "invalidCredentials": "Saisissez un ID de clé d’accès et une clé d’accès secrète valides.",
    "invalidField": "Saisissez une valeur valide.",
    "providerDisabled": "Activez et configurez le stockage S3 avant d’enregistrer les identifiants.",
    "serviceMismatch": "Enregistrez les identifiants du service de stockage sélectionné dans la configuration de l’agence.",
    "credentialsMissing": "Enregistrez les identifiants de stockage de l’agence avant de tester cette connexion.",
    "connectionFailed": "Le test de connexion au stockage a échoué. Vérifiez la configuration, les identifiants, les autorisations et l’accès au réseau."
},
})

export const userErrorMessage = (key: keyof typeof userErrorMessages.en) => ({
  en: translateGcsExtensionMessage(userErrorMessages, 'en', key),
  fr: translateGcsExtensionMessage(userErrorMessages, 'fr', key)
})
