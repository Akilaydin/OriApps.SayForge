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
  it('preserves an intentionally empty saved prompt', async () => {
    state.values.set(AI_PROMPT_KEY,'')
    expect(await getAiPrompt()).toBe('')
  })
  it('retains normalized hotword prompt injection', () => {
    expect(buildHotwordInjectionPart([' RabbitMQ ', 'RabbitMQ', 'C#'])).toContain('RabbitMQ, C#')
    expect(buildHotwordInjectionPart([' '])).toBeNull()
  })
})
