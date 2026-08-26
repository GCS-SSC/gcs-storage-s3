import type { Kysely } from 'kysely'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import {
  createGcsExtensionUserError,
  defineGcsExtensionNitroPlugin,
  registerGcsExtensionConfigurationGuard,
  type GcsExtensionConfigurationGuardContext
} from '@gcs-ssc/extensions/server'
import { parseS3AgencyConfig, S3AgencyConfigSchema, storageBackendFingerprint } from '../../shared/config.ts'
import { EXTENSION_KEY } from '../credentials.ts'

interface StorageConfigurationGuardDatabase {
  'extensions.agency_enablement': {
    id: string
    agency_id: string
    extension_key: string
    config: GcsExtensionJsonConfig
    _deleted: boolean
  }
  Common_Attachment: {
    id: string
    egcs_cn_attachmenttype: string
    egcs_cn_provider: string
    _deleted: boolean
  }
  Common_Attachment_Types: {
    id: string
    egcs_cn_agency: string
  }
}

const backendInUseError = () => createGcsExtensionUserError({
  statusCode: 409,
  code: 'GCS_STORAGE_S3_BACKEND_IN_USE',
  message: {
    en: 'The storage service, bucket, region, or endpoint cannot be changed while active attachments use this provider. Credential rotation and key-prefix changes remain available.',
    fr: 'Le service de stockage, le compartiment, la région ou le point de terminaison ne peut pas être modifié tant que des pièces jointes actives utilisent ce fournisseur. La rotation des identifiants et les changements de préfixe de clé demeurent possibles.'
  }
})

export const guardS3BackendConfiguration = async (
  context: GcsExtensionConfigurationGuardContext
): Promise<void> => {
  if (
    context.extensionKey !== EXTENSION_KEY
    || context.targetExtensionKey !== EXTENSION_KEY
    || context.scope !== 'agency'
    || !context.enabled
    || context.config === undefined
  ) return

  const db = context.db as unknown as Kysely<StorageConfigurationGuardDatabase>
  const existing = await db.selectFrom('extensions.agency_enablement')
    .select(['id', 'config'])
    .where('extension_key', '=', EXTENSION_KEY)
    .where('agency_id', '=', context.agencyId)
    .where('_deleted', '=', false)
    .forUpdate()
    .executeTakeFirst()
  if (!existing) return

  const proposed = parseS3AgencyConfig(context.config)
  const currentResult = S3AgencyConfigSchema.safeParse(existing.config)
  if (!currentResult.success) return
  const current = currentResult.data
  if (storageBackendFingerprint(current) === storageBackendFingerprint(proposed)) return

  const attachment = await db.selectFrom('Common_Attachment')
    .innerJoin('Common_Attachment_Types', 'Common_Attachment_Types.id', 'Common_Attachment.egcs_cn_attachmenttype')
    .select('Common_Attachment.id')
    .where('Common_Attachment.egcs_cn_provider', '=', EXTENSION_KEY)
    .where('Common_Attachment._deleted', '=', false)
    .where('Common_Attachment_Types.egcs_cn_agency', '=', context.agencyId)
    .executeTakeFirst()
  if (attachment) throw backendInUseError()
}

export default defineGcsExtensionNitroPlugin(nitroApp => {
  registerGcsExtensionConfigurationGuard(EXTENSION_KEY, guardS3BackendConfiguration, nitroApp)
})
