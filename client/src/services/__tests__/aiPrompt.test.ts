import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock('../store', () => ({
  getSetting: (key: string, fallback: unknown) => Promise.resolve(state.values.get(key) ?? fallback),
  setSetting: (key: string, value: unknown) => { state.values.set(key,value); return Promise.resolve() },
}))
import { AI_PROMPT_KEY, DEFAULT_AI_PROMPT, getAiPrompt, buildHotwordInjectionPart } from '../aiPrompt'
beforeEach(() => state.values.clear())
describe('single AI prompt migration', () => {
  it('adopts the selected custom prompt and append without modifying legacy records', async () => {
    const raw = [{id:'a',systemPrompt:'First'}, {id:'b',systemPrompt:'Selected'}]
    state.values.set('promptPresets',raw); state.values.set('activePresetId','b'); state.values.set('aiPromptAppend','Extra')
    expect(await getAiPrompt()).toBe('Selected\n\nExtra')
    expect(state.values.get('promptPresets')).toBe(raw)
    state.values.set('activePresetId','a')
    expect(await getAiPrompt()).toBe('Selected\n\nExtra')
  })
  it('uses a safe default for malformed legacy settings', async () => {
    state.values.set('promptPresets','invalid'); state.values.set('aiPromptAppend',42)
    expect(await getAiPrompt()).toBe(DEFAULT_AI_PROMPT)
  })
  it('does not adopt a retired unmodified built-in prompt from restored settings', async () => {
    const presets = [
      { id: 'intent', systemPrompt: 'Retired built-in instructions', builtin: true, builtinPromptModified: false },
    ]
    state.values.set('promptPresets', presets)
    state.values.set('activePresetId', 'intent')
    state.values.set('aiPromptAppend', 'Keep product names')
    expect(await getAiPrompt()).toBe(`${DEFAULT_AI_PROMPT}\n\nKeep product names`)
    expect(state.values.get('promptPresets')).toBe(presets)
  })
  it('preserves previously edited built-ins and user prompts in any language', async () => {
    state.values.set('promptPresets', [
      { id: 'intent', systemPrompt: 'Отредактированный промпт', builtin: true, builtinPromptModified: true },
    ])
    state.values.set('activePresetId', 'intent')
    expect(await getAiPrompt()).toBe('Отредактированный промпт')
    state.values.delete(AI_PROMPT_KEY)
    state.values.set('promptPresets', [
      { id: 'custom', systemPrompt: 'Rédige un texte fidèle', builtin: false },
    ])
    state.values.set('activePresetId', 'custom')
    expect(await getAiPrompt()).toBe('Rédige un texte fidèle')
  })
  it('preserves an intentionally empty saved prompt', async () => {
    state.values.set(AI_PROMPT_KEY,'')
    expect(await getAiPrompt()).toBe('')
  })
  it('retains normalized hotword prompt injection', () => {
    expect(buildHotwordInjectionPart([' RabbitMQ ', 'RabbitMQ', 'C#'])).toContain('RabbitMQ, C#')
    expect(buildHotwordInjectionPart([' '])).toBeNull()
  })
})
