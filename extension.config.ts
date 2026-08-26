import { defineGcsExtension } from '@gcs-ssc/extensions'
export default defineGcsExtension({
  key: 'gcs-storage-s3', sdkVersion: '^0.2.1',
  requiredHostCapabilities: ['agency-config', 'server-handlers', 'server-handler-rbac', 'extension-ui', 'extension-api-client', 'extension-secrets', 'file-storage-provider'],
  name: { en: 'Amazon S3 storage', fr: 'Stockage Amazon S3' },
  description: { en: 'Stores private attachments in an agency-configured Amazon S3 bucket.', fr: 'Stocke les pièces jointes privées dans un compartiment Amazon S3 configuré par l’organisation.' },
  admin: { agency: { path: './components/AgencyS3StorageConfig.vue' } },
  fileStorageProvider: { adapter: { path: './server/storage-adapter.ts' } },
  serverHandlers: [
    { route: '/agencies/[agencyId]/credentials', method: 'get', rbac: { subject: 'agency', action: 'read', agency: { param: 'agencyId' } }, path: './server/api/credentials.get.ts' },
    { route: '/agencies/[agencyId]/credentials', method: 'put', rbac: { subject: 'agency', action: 'update', agency: { param: 'agencyId' } }, path: './server/api/credentials.put.ts' },
    { route: '/agencies/[agencyId]/test', method: 'post', rbac: { subject: 'agency', action: 'update', agency: { param: 'agencyId' } }, path: './server/api/test.post.ts' }
  ]
})

