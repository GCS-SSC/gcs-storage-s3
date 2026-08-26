<script setup lang="ts">
import { computed, onMounted, ref, watch, type Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'
import { ExtensionButton, ExtensionFormField, ExtensionInput, ExtensionSaveButton, useExtensionApi, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import { parseS3AgencyConfig } from '../shared/config'

const { agencyId, extension, enabled = true, disabled = false, readOnly = false } = defineProps<{
  agencyId: string
  extension: GcsResolvedExtension
  enabled?: boolean
  disabled?: boolean
  readOnly?: boolean
}>()
const model = defineModel<GcsExtensionJsonConfig>({ required: true })
const { locale } = useExtensionI18n()
const api = useExtensionApi(extension.key)
const initial = { bucket: '', region: '', keyPrefix: '', credentialMode: 'default-chain' as const, encryption: 'bucket-default' as const }
const local: Ref<Record<string, string>> = ref({ ...initial, ...model.value } as Record<string, string>)
const accessKeyId: Ref<string> = ref('')
const secretAccessKey: Ref<string> = ref('')
const sessionToken: Ref<string> = ref('')
const credentialStatus: Ref<string> = ref('')
const maskedAccessKey: Ref<string | null> = ref(null)
const connectionStatus: Ref<string> = ref('')
const endpoint = `/agencies/${agencyId}`
const isReadOnly = computed(() => disabled || readOnly)
const providerActionsDisabled = computed(() => isReadOnly.value || !enabled)
const labels = {
  en: { bucket: 'Bucket', region: 'Region', prefix: 'Key prefix (optional)', mode: 'Credential mode', defaults: 'Node default credential chain', agency: 'Agency access keys', encryption: 'Encryption', bucketDefault: 'Bucket default', kms: 'SSE-KMS', kmsKey: 'KMS key ID', access: 'Access key ID', secret: 'Secret access key', token: 'Session token (optional)', save: 'Save credentials', test: 'Test connection', saved: 'Credentials saved', connected: 'Connection succeeded', failed: 'Connection failed' },
  fr: { bucket: 'Compartiment', region: 'Région', prefix: 'Préfixe de clé (facultatif)', mode: 'Mode d’identification', defaults: 'Chaîne d’identification Node par défaut', agency: 'Clés d’accès de l’organisation', encryption: 'Chiffrement', bucketDefault: 'Valeur par défaut du compartiment', kms: 'SSE-KMS', kmsKey: 'ID de clé KMS', access: 'ID de clé d’accès', secret: 'Clé d’accès secrète', token: 'Jeton de session (facultatif)', save: 'Enregistrer les identifiants', test: 'Tester la connexion', saved: 'Identifiants enregistrés', connected: 'Connexion réussie', failed: 'Échec de la connexion' }
}
const t = (key: keyof typeof labels.en) => locale.value === 'fr' ? labels.fr[key] : labels.en[key]

watch(local, value => {
  model.value = {
    bucket: value.bucket ?? '', region: value.region ?? '', keyPrefix: value.keyPrefix ?? '',
    credentialMode: value.credentialMode ?? 'default-chain', encryption: value.encryption ?? 'bucket-default',
    ...(value.encryption === 'sse-kms' && value.kmsKeyId ? { kmsKeyId: value.kmsKeyId } : {})
  }
}, { deep: true })

const saveCredentials = async () => {
  if (providerActionsDisabled.value) return
  const summary = await api.put<{ accessKeyIdMasked: string | null }>(`${endpoint}/credentials`, { accessKeyId: accessKeyId.value, secretAccessKey: secretAccessKey.value, ...(sessionToken.value ? { sessionToken: sessionToken.value } : {}) })
  maskedAccessKey.value = summary.accessKeyIdMasked
  accessKeyId.value = ''; secretAccessKey.value = ''; sessionToken.value = ''; credentialStatus.value = t('saved')
}
onMounted(async () => {
  const summary = await api.get<{ accessKeyIdMasked: string | null }>(`${endpoint}/credentials`).catch(() => null)
  maskedAccessKey.value = summary?.accessKeyIdMasked ?? null
})
const testConnection = async () => {
  if (providerActionsDisabled.value) return
  try { const config = parseS3AgencyConfig(model.value); await api.post(`${endpoint}/test`, config); connectionStatus.value = t('connected') } catch { connectionStatus.value = t('failed') }
}
</script>

<template>
  <div class="space-y-4">
    <ExtensionFormField :label="t('bucket')"><ExtensionInput v-model="local.bucket" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField :label="t('region')"><ExtensionInput v-model="local.region" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField :label="t('prefix')"><ExtensionInput v-model="local.keyPrefix" :disabled="isReadOnly" /></ExtensionFormField>
    <ExtensionFormField :label="t('mode')"><select v-model="local.credentialMode" :disabled="isReadOnly"><option value="default-chain">{{ t('defaults') }}</option><option value="agency-secret">{{ t('agency') }}</option></select></ExtensionFormField>
    <ExtensionFormField :label="t('encryption')"><select v-model="local.encryption" :disabled="isReadOnly"><option value="bucket-default">{{ t('bucketDefault') }}</option><option value="sse-kms">{{ t('kms') }}</option></select></ExtensionFormField>
    <ExtensionFormField v-if="local.encryption === 'sse-kms'" :label="t('kmsKey')"><ExtensionInput v-model="local.kmsKeyId" :disabled="isReadOnly" /></ExtensionFormField>
    <template v-if="local.credentialMode === 'agency-secret'">
      <ExtensionFormField :label="t('access')"><ExtensionInput v-model="accessKeyId" :disabled="providerActionsDisabled" /></ExtensionFormField>
      <ExtensionFormField :label="t('secret')"><ExtensionInput v-model="secretAccessKey" type="password" :disabled="providerActionsDisabled" /></ExtensionFormField>
      <ExtensionFormField :label="t('token')"><ExtensionInput v-model="sessionToken" type="password" :disabled="providerActionsDisabled" /></ExtensionFormField>
      <ExtensionSaveButton :label="t('save')" :disabled="providerActionsDisabled" @click="saveCredentials" />
      <p v-if="maskedAccessKey">{{ maskedAccessKey }}</p>
      <p>{{ credentialStatus }}</p>
    </template>
    <ExtensionButton :disabled="providerActionsDisabled" @click="testConnection">{{ t('test') }}</ExtensionButton>
    <p>{{ connectionStatus }}</p>
  </div>
</template>
