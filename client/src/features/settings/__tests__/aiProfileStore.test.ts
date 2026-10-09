import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock('@/services/store', () => ({
  getSetting: (key: string, fallback: unknown) =>
    Promise.resolve(state.values.has(key) ? state.values.get(key) : fallback),
  setSetting: (key: string, value: unknown) => {
    state.values.set(key, value)
    return Promise.resolve()
  },
}))

import {
  AI_ACTIVE_PROFILE_KEY,
  AI_PROFILES_KEY,
  AI_PROFILES_MIGRATED_KEY,
  AI_UNSUPPORTED_RUNTIME_BACKUP_KEY,
  loadAiProfiles,
  saveAiProfiles,
} from '../aiProfileStore'
import { parseProfilesDetailed } from '../aiProviderCatalog'

describe('removed AI provider migration', () => {
  beforeEach(() => state.values.clear())

  it('quarantines unsupported provider profiles without changing stored keys', async () => {
    const legacy = { id: 'old', provider: 'deepseek', apiUrl: 'https://legacy.example/v1', apiKey: 'SECRET', model: 'legacy-model', extra: 'keep me' }
    const valid = { id: 'supported', provider: 'openai_compat', apiUrl: 'https://gateway.example/v1', apiKey: 'LIVE', model: 'example' }
    state.values.set(AI_PROFILES_MIGRATED_KEY, true)
    state.values.set(AI_PROFILES_KEY, [legacy, valid])
    state.values.set(AI_ACTIVE_PROFILE_KEY, 'old')
    state.values.set('cloudAi.provider', 'deepseek')
    state.values.set('cloudAi.apiUrl', legacy.apiUrl)
    state.values.set('cloudAi.apiKey', legacy.apiKey)
    state.values.set('cloudAi.model', legacy.model)

    const loaded = await loadAiProfiles()
    expect(loaded.profiles).toHaveLength(1)
    expect(loaded.profiles[0]).toMatchObject(valid)
    expect(loaded.activeId).toBe('supported')
    expect(state.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(state.values.get('cloudAi.apiKey')).toBe('LIVE')
    expect(state.values.get(AI_UNSUPPORTED_RUNTIME_BACKUP_KEY)).toEqual({
      provider: legacy.provider, apiUrl: legacy.apiUrl, apiKey: legacy.apiKey, model: legacy.model,
    })

    await saveAiProfiles(loaded)
    expect(state.values.get(AI_PROFILES_KEY)).toContainEqual(legacy)
    expect(state.values.get(AI_PROFILES_KEY)).toHaveLength(2)
  })

  it('preserves unsupported profiles when no supported profile is configured', async () => {
    const legacy = { id: 'old', provider: 'qwen', apiUrl: 'https://old.example', apiKey: 'LEGACY-SECRET', model: 'model' }
    state.values.set(AI_PROFILES_MIGRATED_KEY, true)
    state.values.set(AI_PROFILES_KEY, [legacy])
    state.values.set(AI_ACTIVE_PROFILE_KEY, 'old')
    state.values.set('cloudAi.provider', legacy.provider)
    state.values.set('cloudAi.apiKey', legacy.apiKey)
    const loaded = await loadAiProfiles()
    expect(loaded).toEqual({ profiles: [], activeId: '' })
    expect(state.values.get(AI_PROFILES_KEY)).toEqual([legacy])
    expect(state.values.get('cloudAi.provider')).toBe('')
    expect(state.values.get(AI_UNSUPPORTED_RUNTIME_BACKUP_KEY)).toMatchObject({
      provider: 'qwen', apiKey: 'LEGACY-SECRET',
    })
  })

  it('does not treat a removed provider as the default supported provider', () => {
    const legacy = { id: 'old', provider: 'mimo', apiKey: 'DO-NOT-LOSE' }
    const result = parseProfilesDetailed([legacy])
    expect(result.profiles).toEqual([])
    expect(result.orphans).toEqual([legacy])
  })

  it('does not overwrite a saved backup of old runtime credentials', async () => {
    state.values.set(AI_PROFILES_MIGRATED_KEY, true)
    state.values.set(AI_PROFILES_KEY, [])
    state.values.set('cloudAi.provider', 'zhipu')
    state.values.set('cloudAi.apiKey', 'OTHER')
    state.values.set(AI_UNSUPPORTED_RUNTIME_BACKUP_KEY, {
      provider: 'deepseek', apiKey: 'ORIGINAL',
    })
    await loadAiProfiles()
    expect(state.values.get(AI_UNSUPPORTED_RUNTIME_BACKUP_KEY)).toEqual({
      provider: 'deepseek', apiKey: 'ORIGINAL',
    })
  })
})
