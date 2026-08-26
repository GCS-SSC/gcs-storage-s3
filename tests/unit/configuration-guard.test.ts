import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guardS3BackendConfiguration } from '../../server/plugins/configuration-guard'

const currentConfig = { service: 'amazon-s3', bucket: 'bucket', region: 'ca-central-1' }

const query = (result: unknown) => {
  const builder = {
    select: vi.fn(), where: vi.fn(), forUpdate: vi.fn(), innerJoin: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValue(result)
  }
  builder.select.mockReturnValue(builder)
  builder.where.mockReturnValue(builder)
  builder.forUpdate.mockReturnValue(builder)
  builder.innerJoin.mockReturnValue(builder)
  return builder
}

const guardContext = (config: Record<string, unknown>, attachment: unknown = undefined, existingConfig: Record<string, unknown> = currentConfig) => {
  const events: string[] = []
  const enablement = query({ id: '1', config: existingConfig })
  const attachments = query(attachment)
  const db = {
    selectFrom: vi.fn((table: string) => {
      events.push(table)
      return table === 'extensions.agency_enablement' ? enablement : attachments
    })
  }
  return {
    events,
    enablement,
    attachments,
    context: {
      extensionKey: 'gcs-storage-s3', targetExtensionKey: 'gcs-storage-s3', scope: 'agency',
      agencyId: '17', enabled: true, config, db, event: {}
    } as unknown as Parameters<typeof guardS3BackendConfiguration>[0]
  }
}

describe('S3 backend configuration guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('locks enablement and skips attachment lookup when the backend fingerprint is unchanged', async () => {
    const fixture = guardContext({ ...currentConfig, keyPrefix: 'new-prefix' })
    await expect(guardS3BackendConfiguration(fixture.context)).resolves.toBeUndefined()
    expect(fixture.enablement.forUpdate).toHaveBeenCalledOnce()
    expect(fixture.events).toEqual(['extensions.agency_enablement'])
  })

  it('permits backend changes only when no active attachment references the provider', async () => {
    const fixture = guardContext({ service: 'backblaze-b2', bucket: 'bucket', endpoint: 's3.us-east-005.backblazeb2.com', credentialMode: 'agency-secret' })
    await expect(guardS3BackendConfiguration(fixture.context)).resolves.toBeUndefined()
    expect(fixture.events).toEqual(['extensions.agency_enablement', 'Common_Attachment'])
  })

  it('allows initial configuration when the enabled row has no valid backend yet', async () => {
    const fixture = guardContext({ ...currentConfig }, undefined, {})
    await expect(guardS3BackendConfiguration(fixture.context)).resolves.toBeUndefined()
    expect(fixture.events).toEqual(['extensions.agency_enablement'])
  })

  it('rejects a changed backend after locking when an active attachment exists', async () => {
    const fixture = guardContext({ service: 'backblaze-b2', bucket: 'bucket', endpoint: 's3.us-east-005.backblazeb2.com', credentialMode: 'agency-secret' }, { id: '9' })
    await expect(guardS3BackendConfiguration(fixture.context)).rejects.toMatchObject({
      statusCode: 409,
      code: 'GCS_STORAGE_S3_BACKEND_IN_USE'
    })
    expect(fixture.events).toEqual(['extensions.agency_enablement', 'Common_Attachment'])
  })

  it('ignores unrelated configuration hooks', async () => {
    const fixture = guardContext(currentConfig)
    await expect(guardS3BackendConfiguration({ ...fixture.context, targetExtensionKey: 'other' })).resolves.toBeUndefined()
    expect(fixture.events).toEqual([])
  })
})
