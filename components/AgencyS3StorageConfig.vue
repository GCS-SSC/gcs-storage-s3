<script setup lang="ts">
import { computed, onMounted, ref, watch, type Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'
import { ExtensionButton, ExtensionFormField, ExtensionInput, ExtensionSaveButton, useExtensionApi, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import { parseS3AgencyConfig } from '../shared/config'

const { agencyId, extension, persistedConfig, enabled = true, disabled = false, readOnly = false } = defineProps<{
  agencyId: string
  extension: GcsResolvedExtension
  persistedConfig?: GcsExtensionJsonConfig
  enabled?: boolean
  disabled?: boolean
  readOnly?: boolean
}>()
const model = defineModel<GcsExtensionJsonConfig>({ required: true })
const { locale } = useExtensionI18n()
const api = useExtensionApi(extension.key)
const initial = { service: 'amazon-s3', bucket: '', region: '', endpoint: '', keyPrefix: '', credentialMode: 'default-chain' as const, encryption: 'bucket-default' as const }
const local: Ref<Record<string, string>> = ref({ ...initial, ...model.value } as Record<string, string>)
const accessKeyId: Ref<string> = ref('')
const secretAccessKey: Ref<string> = ref('')
const sessionToken: Ref<string> = ref('')
const credentialStatus: Ref<string> = ref('')
const maskedAccessKey: Ref<string | null> = ref(null)
const connectionStatus: Ref<string> = ref('')
const connectionPending: Ref<boolean> = ref(false)
const endpoint = `/agencies/${agencyId}`
const isReadOnly = computed(() => disabled || readOnly)
const providerActionsDisabled = computed(() => isReadOnly.value || !enabled)
const persistedBackendMatches = computed(() => {
  try {
    const draft = parseS3AgencyConfig(model.value)
    const persisted = parseS3AgencyConfig(persistedConfig ?? {})
    return draft.service === persisted.service
      && draft.bucket === persisted.bucket
      && draft.region === persisted.region
      && draft.endpoint === persisted.endpoint
      && draft.forcePathStyle === persisted.forcePathStyle
  } catch {
    return false
  }
})
const connectionActionsDisabled = computed(() => providerActionsDisabled.value || !persistedBackendMatches.value)
const isBackblaze = computed(() => local.value.service === 'backblaze-b2')
const labels = {
  en: { service: 'Storage service', amazon: 'Amazon S3', backblaze: 'Backblaze B2', bucket: 'Bucket', region: 'AWS region', b2Endpoint: 'Backblaze B2 S3 endpoint', prefix: 'Key prefix (optional)', mode: 'Credential mode', defaults: 'Node default credential chain', agency: 'Agency access keys', encryption: 'Encryption', bucketDefault: 'Bucket default', kms: 'SSE-KMS', kmsKey: 'KMS key ID', access: 'Access key ID / B2 key ID', secret: 'Secret access key / B2 application key', token: 'Session token (optional)', save: 'Save credentials', test: 'Test connection', saved: 'Credentials saved', credentialFailed: 'Credentials could not be saved', saveConfigFirst: 'Save this configuration before managing credentials or testing the connection.', connected: 'Connection succeeded', failed: 'Connection failed' },
  fr: { service: 'Service de stockage', amazon: 'Amazon S3', backblaze: 'Backblaze B2', bucket: 'Compartiment', region: 'Région AWS', b2Endpoint: 'Point de terminaison S3 Backblaze B2', prefix: 'Préfixe de clé (facultatif)', mode: 'Mode d’identification', defaults: 'Chaîne d’identification Node par défaut', agency: 'Clés d’accès de l’organisation', encryption: 'Chiffrement', bucketDefault: 'Valeur par défaut du compartiment', kms: 'SSE-KMS', kmsKey: 'ID de clé KMS', access: 'ID de clé d’accès / ID de clé B2', secret: 'Clé d’accès secrète / clé d’application B2', token: 'Jeton de session (facultatif)', save: 'Enregistrer les identifiants', test: 'Tester la connexion', saved: 'Identifiants enregistrés', credentialFailed: 'Impossible d’enregistrer les identifiants', saveConfigFirst: 'Enregistrez cette configuration avant de gérer les identifiants ou de tester la connexion.', connected: 'Connexion réussie', failed: 'Échec de la connexion' }
}
const t = (key: keyof typeof labels.en) => locale.value === 'fr' ? labels.fr[key] : labels.en[key]

watch(local, value => {
  model.value = {
    service: value.service ?? 'amazon-s3', bucket: value.bucket ?? '', keyPrefix: value.keyPrefix ?? '',
    ...(value.service === 'backblaze-b2' ? { endpoint: value.endpoint ?? '' } : { region: value.region ?? '' }),
    credentialMode: value.credentialMode ?? 'default-chain', encryption: value.encryption ?? 'bucket-default',
    ...(value.encryption === 'sse-kms' && value.kmsKeyId ? { kmsKeyId: value.kmsKeyId } : {})
  }
}, { deep: true })

watch(isBackblaze, value => {
  if (!value) return
  local.value.credentialMode = 'agency-secret'
  local.value.encryption = 'bucket-default'
  delete local.value.kmsKeyId
})

const saveCredentials = async () => {
  if (connectionActionsDisabled.value) return
  try {
    const summary = await api.put<{ accessKeyIdMasked: string | null }>(`${endpoint}/credentials`, {
      service: local.value.service ?? 'amazon-s3',
      accessKeyId: accessKeyId.value,
      secretAccessKey: secretAccessKey.value,
      ...(!isBackblaze.value && sessionToken.value ? { sessionToken: sessionToken.value } : {})
    })
    maskedAccessKey.value = summary.accessKeyIdMasked
    accessKeyId.value = ''; secretAccessKey.value = ''; sessionToken.value = ''; credentialStatus.value = t('saved')
  } catch {
    credentialStatus.value = t('credentialFailed')
  }
}
onMounted(async () => {
  const summary = await api.get<{ accessKeyIdMasked: string | null }>(`${endpoint}/credentials`).catch(() => null)
  maskedAccessKey.value = summary?.accessKeyIdMasked ?? null
})
const testConnection = async () => {
  if (connectionActionsDisabled.value || connectionPending.value) return
  connectionPending.value = true
  try { const config = parseS3AgencyConfig(model.value); await api.post(`${endpoint}/test`, config); connectionStatus.value = t('connected') } catch { connectionStatus.value = t('failed') } finally { connectionPending.value = false }
}
</script>

<template>
  <div class="space-y-4">
    <ExtensionFormField :label="t('service')"><select v-model="local.service" :disabled="isReadOnly"><option value="amazon-s3">{{ t('amazon') }}</option><option value="backblaze-b2">{{ t('backblaze') }}</option></select></ExtensionFormField>
    <ExtensionFormField :label="t('bucket')"><ExtensionInput v-model="local.bucket" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField v-if="isBackblaze" :label="t('b2Endpoint')"><ExtensionInput v-model="local.endpoint" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField v-else :label="t('region')"><ExtensionInput v-model="local.region" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField :label="t('prefix')"><ExtensionInput v-model="local.keyPrefix" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField v-if="!isBackblaze" :label="t('mode')"><select v-model="local.credentialMode" :disabled="isReadOnly"><option value="default-chain">{{ t('defaults') }}</option><option value="agency-secret">{{ t('agency') }}</option></select></ExtensionFormField>
    <ExtensionFormField v-if="!isBackblaze" :label="t('encryption')"><select v-model="local.encryption" :disabled="isReadOnly"><option value="bucket-default">{{ t('bucketDefault') }}</option><option value="sse-kms">{{ t('kms') }}</option></select></ExtensionFormField>
    <ExtensionFormField v-if="local.encryption === 'sse-kms'" :label="t('kmsKey')"><ExtensionInput v-model="local.kmsKeyId" :disabled="isReadOnly" /></ExtensionFormField>
    <template v-if="local.credentialMode === 'agency-secret'">
      <ExtensionFormField :label="t('access')"><ExtensionInput v-model="accessKeyId" :disabled="connectionActionsDisabled" /></ExtensionFormField>
      <ExtensionFormField :label="t('secret')"><ExtensionInput v-model="secretAccessKey" type="password" :disabled="connectionActionsDisabled" /></ExtensionFormField>
      <ExtensionFormField v-if="!isBackblaze" :label="t('token')"><ExtensionInput v-model="sessionToken" type="password" :disabled="connectionActionsDisabled" /></ExtensionFormField>
      <ExtensionSaveButton :label="t('save')" :disabled="connectionActionsDisabled" @click="saveCredentials" />
      <p v-if="maskedAccessKey">{{ maskedAccessKey }}</p>
      <p>{{ credentialStatus }}</p>
    </template>
    <p v-if="!providerActionsDisabled && !persistedBackendMatches">{{ t('saveConfigFirst') }}</p>
    <ExtensionButton :disabled="connectionActionsDisabled || connectionPending" @click="testConnection">{{ t('test') }}</ExtensionButton>
    <p>{{ connectionStatus }}</p>
  </div>
</template>
