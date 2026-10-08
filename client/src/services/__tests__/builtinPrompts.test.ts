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

import { getDefault } from '../defaults'
import {
  BUILTIN_PRESETS,
  builtinPromptContentHash,
  getBuiltinPromptPresets,
  getPromptPresets,
  normalizeBuiltinPromptLanguage,
  savePromptPreset,
  setBuiltinPromptLanguage,
  type PromptPreset,
} from '../store'

describe('English-only built-in prompts', () => {
  beforeEach(() => bridgeState.values.clear())

  it('uses English for new and legacy language preferences', () => {
    expect(getDefault('ai.builtinPromptLanguage')).toBe('en')
    for (const value of ['en', 'zh-CN', '', null, undefined, 1]) {
      expect(normalizeBuiltinPromptLanguage(value)).toBe('en')
    }
  })
  it('exposes three distinct English presets and no Chinese translation preset', () => {
    const en = getBuiltinPromptPresets('en')
    expect(en.map((preset) => preset.id)).toEqual(['intent', 'faithful', 'casual'])
    expect(en.map((preset) => preset.id)).toEqual(BUILTIN_PRESETS.map((preset) => preset.id))
    expect(en.every((preset) => preset.systemPrompt.length > 100 && preset.builtinPromptLanguage === 'en')).toBe(true)
  })
  it('persists custom English overrides without touching unrelated user data', async () => {
    await setBuiltinPromptLanguage('en')
    const current = getBuiltinPromptPresets('en')[0]
    await savePromptPreset({ ...current, systemPrompt: 'Custom instruction' })
    const stored = bridgeState.values.get('promptPresets') as PromptPreset[]
    expect(stored[0].builtinPromptBaseHash).toBe(builtinPromptContentHash(current.systemPrompt))
    expect((await getPromptPresets())[0].systemPrompt).toBe('Custom instruction')
    await savePromptPreset(current)
    expect((await getPromptPresets())[0].systemPrompt).toBe(current.systemPrompt)
  })
  it('keeps legacy user-written overrides but displays them as English-profile customizations', async () => {
    bridgeState.values.set('promptPresets', [{ id: 'intent', name: 'old', systemPrompt: 'User-authored prompt' }])
    const preset = (await getPromptPresets())[0]
    expect(preset.systemPrompt).toBe('User-authored prompt')
    expect(preset.builtinPromptModified).toBe(true)
  })
  it('reports an outdated modified base hash and removes redundant saved snapshots', async () => {
    bridgeState.values.set('promptPresets', [{
      id: 'intent', name: 'Intent cleanup', systemPrompt: 'Custom', builtinPromptLanguage: 'en',
      builtinPromptBaseHash: 'older-version',
    } satisfies PromptPreset])
    expect((await getPromptPresets('en'))[0].builtinPromptUpdateAvailable).toBe(true)
    const current = getBuiltinPromptPresets('en')[0]
    bridgeState.values.set('promptPresets', [{ ...current, systemPrompt: current.systemPrompt }])
    expect((await getPromptPresets('en'))[0].builtinPromptModified).toBeUndefined()
    expect(bridgeState.values.get('promptPresets')).toEqual([])
  })
})
