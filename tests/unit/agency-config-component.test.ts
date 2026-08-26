// @vitest-environment jsdom

import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
const put = vi.fn()
const post = vi.fn()

vi.mock('@gcs-ssc/extensions/ui', () => ({
  useExtensionApi: () => ({ get, put, post }),
  useExtensionI18n: () => ({ locale: { value: 'en' } }),
  ExtensionFormField: defineComponent({
    setup(_props, { slots }) {
      return () => h('label', slots.default?.())
    }
  }),
  ExtensionInput: defineComponent({
    props: { modelValue: { type: String, default: '' }, disabled: Boolean, type: { type: String, default: 'text' } },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () => h('input', {
        value: props.modelValue,
        disabled: props.disabled,
        type: props.type,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
    }
  }),
  ExtensionButton: defineComponent({
    props: { disabled: Boolean },
    emits: ['click'],
    setup(props, { emit, slots }) {
      return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.())
    }
  }),
  ExtensionSaveButton: defineComponent({
    props: { disabled: Boolean, label: { type: String, default: '' } },
    emits: ['click'],
    setup(props, { emit }) {
      return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, props.label)
    }
  })
}))

import AgencyS3StorageConfig from '../../components/AgencyS3StorageConfig.vue'

const extension = { key: 'gcs-storage-s3' } as never
const config = {
  bucket: 'private-bucket',
  region: 'ca-central-1',
  keyPrefix: '',
  credentialMode: 'agency-secret',
  encryption: 'bucket-default'
}

describe('AgencyS3StorageConfig', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ accessKeyIdMasked: 'AKIA••••WXYZ' })
    put.mockReset().mockResolvedValue({ accessKeyIdMasked: 'AKIA••••WXYZ' })
    post.mockReset().mockResolvedValue({})
  })

  it('shows masked credential state while disabling every mutation for a Viewer', async () => {
    const wrapper = mount(AgencyS3StorageConfig, {
      props: { agencyId: '17', extension, modelValue: config, disabled: true, readOnly: true }
    })
    await flushPromises()

    expect(get).toHaveBeenCalledWith('/agencies/17/credentials')
    expect(wrapper.text()).toContain('AKIA••••WXYZ')
    expect(wrapper.findAll('input').every(input => input.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.findAll('select').every(select => select.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  it('permits credential and connection operations only for an enabled editable provider', async () => {
    const wrapper = mount(AgencyS3StorageConfig, {
      props: { agencyId: '17', extension, modelValue: config, persistedConfig: config, enabled: true }
    })
    await flushPromises()

    const inputs = wrapper.findAll('input')
    await inputs[3]!.setValue('AKIAEXAMPLE')
    await inputs[4]!.setValue('secret-value')
    await wrapper.findAll('button')[0]!.trigger('click')
    await wrapper.findAll('button')[1]!.trigger('click')

    expect(put).toHaveBeenCalledWith('/agencies/17/credentials', expect.objectContaining({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-value'
    }))
    expect(post).toHaveBeenCalledWith('/agencies/17/test', expect.objectContaining({
      bucket: 'private-bucket', region: 'ca-central-1', credentialMode: 'agency-secret'
    }))
  })

  it('configures B2 with an endpoint and mandatory encrypted agency credentials', async () => {
    const wrapper = mount(AgencyS3StorageConfig, {
      props: {
        agencyId: '17', extension, enabled: true,
        persistedConfig: {
          service: 'backblaze-b2', bucket: 'private-bucket', endpoint: 's3.us-east-005.backblazeb2.com',
          keyPrefix: '', credentialMode: 'agency-secret', encryption: 'bucket-default'
        },
        modelValue: {
          service: 'backblaze-b2', bucket: 'private-bucket', endpoint: 's3.us-east-005.backblazeb2.com',
          keyPrefix: '', credentialMode: 'agency-secret', encryption: 'bucket-default'
        }
      }
    })
    await flushPromises()

    expect(wrapper.findAll('select')).toHaveLength(1)
    expect(wrapper.findAll('input').map(input => input.element.value)).toContain('s3.us-east-005.backblazeb2.com')
    expect(wrapper.text()).not.toContain('Node default credential chain')
    expect(wrapper.text()).not.toContain('SSE-KMS')
    expect(wrapper.findAll('input').some(input => input.attributes('type') === 'password')).toBe(true)
    await wrapper.findAll('button')[1]!.trigger('click')
    expect(post).toHaveBeenCalledWith('/agencies/17/test', expect.objectContaining({
      service: 'backblaze-b2', endpoint: 'https://s3.us-east-005.backblazeb2.com', region: 'us-east-005',
      credentialMode: 'agency-secret', encryption: 'bucket-default'
    }))
  })

  it('prevents duplicate concurrent connection canaries', async () => {
    let resolvePost: (() => void) | undefined
    post.mockReturnValue(new Promise<void>(resolve => { resolvePost = resolve }))
    const wrapper = mount(AgencyS3StorageConfig, {
      props: { agencyId: '17', extension, modelValue: config, persistedConfig: config, enabled: true }
    })
    await flushPromises()
    const button = wrapper.findAll('button')[1]!
    await button.trigger('click')
    await button.trigger('click')
    expect(post).toHaveBeenCalledTimes(1)
    expect(button.attributes('disabled')).toBeDefined()
    resolvePost?.()
    await flushPromises()
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('requires backend configuration changes to be saved before credentials or canaries run', async () => {
    const wrapper = mount(AgencyS3StorageConfig, {
      props: {
        agencyId: '17', extension, enabled: true, persistedConfig: {},
        modelValue: {
          service: 'backblaze-b2', bucket: 'private-bucket', endpoint: 's3.us-east-005.backblazeb2.com',
          keyPrefix: '', credentialMode: 'agency-secret', encryption: 'bucket-default'
        }
      }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Save this configuration before managing credentials')
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    expect(put).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })
})
