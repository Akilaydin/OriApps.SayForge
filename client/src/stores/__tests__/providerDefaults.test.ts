import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeState = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}))

vi.mock('@/services/bridge', () => ({
  storeGet: vi.fn(async (key: string) => bridgeState.values.get(key) ?? null),
  storeSet: vi.fn(async (key: string, value: unknown) => {
    bridgeState.values.set(key, value)
  }),
}))

import { initProviderDefaults } from '../providerDefaults'

describe('provider defaults and retired settings preservation', () => {
  beforeEach(() => bridgeState.values.clear())

  it('defaults to OpenAI-compatible without changing retired settings', async () => {
    await initProviderDefaults()
    expect(bridgeState.values.has('localAsr.downloadSource')).toBe(false)
    expect(bridgeState.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(bridgeState.values.has('localAsr.modelId')).toBe(false)
  })

  it('does not overwrite existing unrelated settings', async () => {
    bridgeState.values.set('localAsr.downloadSource', 'Custom source')
    bridgeState.values.set('cloudAi.provider', '')
    bridgeState.values.set('cloudAi.model', 'my-model')
    await initProviderDefaults()
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('Custom source')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('')
    expect(bridgeState.values.get('cloudAi.model')).toBe('my-model')
  })
  it.each(['retired-local-model', 'custom-local-model']) (
    'preserves the retired model selection %s', async (id) => {
      bridgeState.values.set('localAsr.modelId', id)
      bridgeState.values.set('cloudAi.provider', 'custom-user-provider')
      await initProviderDefaults()
      expect(bridgeState.values.get('localAsr.modelId')).toBe(id)
      expect(bridgeState.values.get('cloudAi.provider')).toBe('custom-user-provider')
    },
  )

  it('backs up removed ASR provider credentials and disables the old runtime route', async () => {
    const savedProfile = { id: 'old', provider: 'retired-vendor', model: 'legacy', apiKey: 'PROFILE-KEY' }
    bridgeState.values.set('cloudAsr.profiles', [savedProfile])
    bridgeState.values.set('cloudAsr.provider', 'retired-vendor')
    bridgeState.values.set('cloudAsr.apiKey', 'PRIVATE')
    bridgeState.values.set('cloudAsr.model', 'old-asr')
    bridgeState.values.set('cloudAsr.systemInstruction', 'Preserve the original')
    await initProviderDefaults()
    expect(bridgeState.values.get('cloudAsr.provider')).toBe('')
    expect(bridgeState.values.get('cloudAsr.apiKey')).toBe('')
    expect(bridgeState.values.get('cloudAsr.profiles')).toEqual([savedProfile])
    expect(bridgeState.values.get('cloudAsr.unsupportedRuntimeBackup')).toMatchObject({
      provider: 'retired-vendor', apiKey: 'PRIVATE', model: 'old-asr',
      systemInstruction: 'Preserve the original',
    })
  })

  it.each(['groq_whisper','openai_transcribe'])('keeps migratable HTTP credentials %s available for profile migration', async (provider) => {
    bridgeState.values.set('cloudAsr.provider',provider)
    bridgeState.values.set('cloudAsr.apiKey','legacy-test')
    bridgeState.values.set('cloudAsr.baseUrl','https://relay.example/v1')
    await initProviderDefaults()
    expect(bridgeState.values.get('cloudAsr.provider')).toBe(provider)
    expect(bridgeState.values.get('cloudAsr.apiKey')).toBe('legacy-test')
    expect(bridgeState.values.get('cloudAsr.baseUrl')).toBe('https://relay.example/v1')
  })
  it('keeps supported custom gateway credentials unchanged on startup', async () => {
    bridgeState.values.set('cloudAsr.provider', 'openai_compat')
    bridgeState.values.set('cloudAsr.apiKey', 'LIVE-CREDENTIAL')
    bridgeState.values.set('cloudAsr.model', 'gemini-example')
    await initProviderDefaults()
    expect(bridgeState.values.get('cloudAsr.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('cloudAsr.apiKey')).toBe('LIVE-CREDENTIAL')
    expect(bridgeState.values.get('cloudAsr.model')).toBe('gemini-example')
    expect(bridgeState.values.has('cloudAsr.unsupportedRuntimeBackup')).toBe(false)
  })
})
