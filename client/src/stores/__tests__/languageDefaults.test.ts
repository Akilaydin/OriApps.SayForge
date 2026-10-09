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

describe('English-only first-run defaults and local-model migration', () => {
  beforeEach(() => bridgeState.values.clear())

  it('defaults to Hugging Face, Nemotron, OpenAI-compatible and English prompts', async () => {
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('HuggingFace')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('en')
    expect(bridgeState.values.get('localAsr.modelId')).toBe('nemotron-asr-streaming-0.6b-gguf')
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
    'migrates unsupported legacy model %s to Nemotron without deleting other settings', async (id) => {
      bridgeState.values.set('localAsr.modelId', id)
      bridgeState.values.set('cloudAi.provider', 'custom-user-provider')
      await initLocaleDefaults('en')
      expect(bridgeState.values.get('localAsr.modelId')).toBe('nemotron-asr-streaming-0.6b-gguf')
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
