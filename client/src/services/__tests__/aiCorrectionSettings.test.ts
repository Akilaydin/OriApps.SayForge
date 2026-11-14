import { beforeEach, describe, expect, it, vi } from 'vitest'

const { settings, setSetting } = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value)
  }),
}))

vi.mock('../store', () => ({
  getSetting: (key: string, fallback: unknown) =>
    Promise.resolve(settings.has(key) ? settings.get(key) : fallback),
  setSetting,
}))

import {
  DEFAULT_AI_CORRECTION_PROMPT,
  isAiCorrectionConfigured,
  loadAiCorrectionSettings,
  saveAiCorrectionSettings,
  type AiCorrectionSettings,
} from '../aiCorrectionSettings'

const complete: AiCorrectionSettings = {
  enabled: true,
  apiUrl: 'https://ai.example.test/v1',
  apiKey: 'synthetic-key',
  model: 'synthetic-model',
  prompt: 'Fix punctuation.',
}

describe('AI correction settings', () => {
  beforeEach(() => {
    settings.clear()
    setSetting.mockClear()
  })

  it('starts disabled and supplies the original cleanup prompt', async () => {
    expect(await loadAiCorrectionSettings()).toEqual({
      enabled: false,
      apiUrl: '',
      apiKey: '',
      model: '',
      prompt: DEFAULT_AI_CORRECTION_PROMPT,
    })
  })

  it('preserves the existing flat settings, including a custom prompt and enabled toggle', async () => {
    settings.set('aiEnabled', true)
    settings.set('cloudAi.apiUrl', 'http://localhost:11434/v1')
    settings.set('cloudAi.apiKey', 'legacy-key')
    settings.set('cloudAi.model', 'legacy-model')
    settings.set('cloudAi.systemPrompt', 'Keep capitalization.')

    expect(await loadAiCorrectionSettings()).toEqual({
      enabled: true,
      apiUrl: 'http://localhost:11434/v1',
      apiKey: 'legacy-key',
      model: 'legacy-model',
      prompt: 'Keep capitalization.',
    })
    expect(setSetting).not.toHaveBeenCalled()
  })

  it('saves to the legacy keys and keeps ASR credentials separate', async () => {
    settings.set('cloudAsr.apiKey', 'asr-key')
    await saveAiCorrectionSettings({ ...complete, prompt: '' })

    expect(settings.get('aiEnabled')).toBe(true)
    expect(settings.get('cloudAi.provider')).toBe('openai_compat')
    expect(settings.get('cloudAi.apiUrl')).toBe(complete.apiUrl)
    expect(settings.get('cloudAi.apiKey')).toBe(complete.apiKey)
    expect(settings.get('cloudAi.model')).toBe(complete.model)
    expect(settings.get('cloudAi.systemPrompt')).toBe('')
    expect(settings.get('cloudAsr.apiKey')).toBe('asr-key')
    expect((await loadAiCorrectionSettings()).prompt).toBe('')
  })

  it('requires encrypted remote transport but permits loopback HTTP for local providers', () => {
    expect(isAiCorrectionConfigured({ ...complete, enabled: false, prompt: '' })).toBe(true)
    expect(isAiCorrectionConfigured({ ...complete, apiKey: ' ' })).toBe(false)
    expect(isAiCorrectionConfigured({ ...complete, model: '' })).toBe(false)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'not-a-url' })).toBe(false)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'ftp://ai.example.test' })).toBe(false)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://127.0.0.1:11434/v1' })).toBe(true)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://localhost:3000/v1' })).toBe(true)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://[::1]:11434/v1' })).toBe(true)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://127.2.3.4:3000/v1' })).toBe(true)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://192.168.1.1:3000/v1' })).toBe(false)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://example.com/v1' })).toBe(false)
    expect(isAiCorrectionConfigured({ ...complete, apiUrl: 'http://localhost.attacker.example/v1' })).toBe(false)
  })
})
