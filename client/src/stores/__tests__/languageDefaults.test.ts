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

import { initLocaleDefaults } from '../language'

describe('English-only first-run defaults and retired settings preservation', () => {
  beforeEach(() => bridgeState.values.clear())

  it('defaults to OpenAI-compatible and English prompts', async () => {
    await initLocaleDefaults('en')
    expect(bridgeState.values.has('localAsr.downloadSource')).toBe(false)
    expect(bridgeState.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('en')
    expect(bridgeState.values.has('localAsr.modelId')).toBe(false)
  })

  it('does not overwrite existing unrelated settings', async () => {
    bridgeState.values.set('localAsr.downloadSource', 'Custom source')
    bridgeState.values.set('cloudAi.provider', '')
    bridgeState.values.set('ai.builtinPromptLanguage', 'zh-CN')
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('Custom source')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('zh-CN')
  })
  it.each(['sensevoice-small-gguf', 'funasr-nano-2512-gguf',
    'qwen3-asr-0.6b-gguf', 'qwen3-asr-1.7b-q4-gguf', 'qwen3-asr-1.7b-gguf']) (
    'preserves the retired model selection %s', async (id) => {
      bridgeState.values.set('localAsr.modelId', id)
      bridgeState.values.set('cloudAi.provider', 'custom-user-provider')
      await initLocaleDefaults('en')
      expect(bridgeState.values.get('localAsr.modelId')).toBe(id)
      expect(bridgeState.values.get('cloudAi.provider')).toBe('custom-user-provider')
    },
  )

  it('backs up removed ASR provider credentials and disables the old runtime route', async () => {
    const savedProfile = { id: 'old', provider: 'qwen', model: 'legacy', apiKey: 'PROFILE-KEY' }
    bridgeState.values.set('cloudAsr.profiles', [savedProfile])
    bridgeState.values.set('cloudAsr.provider', 'qwen')
    bridgeState.values.set('cloudAsr.apiKey', 'PRIVATE')
    bridgeState.values.set('cloudAsr.model', 'qwen-asr')
    bridgeState.values.set('cloudAsr.qwen.workspaceId', 'workspace-secret')
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('cloudAsr.provider')).toBe('')
    expect(bridgeState.values.get('cloudAsr.apiKey')).toBe('')
    expect(bridgeState.values.get('cloudAsr.profiles')).toEqual([savedProfile])
    expect(bridgeState.values.get('cloudAsr.unsupportedRuntimeBackup')).toMatchObject({
      provider: 'qwen', apiKey: 'PRIVATE', model: 'qwen-asr',
      'qwen.workspaceId': 'workspace-secret',
    })
  })

  it.each(['groq_whisper','openai_transcribe'])('keeps migratable HTTP credentials %s available for profile migration', async (provider) => {
    bridgeState.values.set('cloudAsr.provider',provider)
    bridgeState.values.set('cloudAsr.apiKey','legacy-test')
    bridgeState.values.set('cloudAsr.baseUrl','https://relay.example/v1')
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('cloudAsr.provider')).toBe(provider)
    expect(bridgeState.values.get('cloudAsr.apiKey')).toBe('legacy-test')
    expect(bridgeState.values.get('cloudAsr.baseUrl')).toBe('https://relay.example/v1')
  })
  it('keeps supported custom gateway credentials unchanged on startup', async () => {
    bridgeState.values.set('cloudAsr.provider', 'openai_compat')
    bridgeState.values.set('cloudAsr.apiKey', 'LIVE-CREDENTIAL')
    bridgeState.values.set('cloudAsr.model', 'gemini-example')
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('cloudAsr.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('cloudAsr.apiKey')).toBe('LIVE-CREDENTIAL')
    expect(bridgeState.values.get('cloudAsr.model')).toBe('gemini-example')
    expect(bridgeState.values.has('cloudAsr.unsupportedRuntimeBackup')).toBe(false)
  })
})
