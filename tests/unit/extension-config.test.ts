import { describe, expect, it } from 'vitest'
import extension from '../../extension.config'

describe('S3 storage extension manifest', () => {
  it('registers the storage adapter, guarded configuration lifecycle, and encrypted credential routes', () => {
    expect(extension.requiredHostCapabilities).toContain('file-storage-provider')
    expect(extension.requiredHostCapabilities).toContain('extension-secrets')
    expect(extension.requiredHostCapabilities).toContain('extension-lifecycle-hooks')
    expect(extension.nitroPlugin).toBe('./server/plugins/configuration-guard.ts')
    expect(extension.fileStorageProvider?.adapter.path).toBe('./server/storage-adapter.ts')
  })
})
