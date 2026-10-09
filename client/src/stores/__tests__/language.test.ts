import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  readFails: false,
  writeFails: false,
  writes: [] as Array<[string, unknown]>,
}))

vi.mock('@/services/store', () => ({
  getSetting: async (key: string, fallback: unknown) => {
    if (state.readFails) throw new Error('Storage is unavailable')
    return state.values.has(key) ? state.values.get(key) : fallback
  },
  setSetting: async (key: string, value: unknown) => {
    state.writes.push([key, value])
    if (state.writeFails) throw new Error('Storage is read-only')
    state.values.set(key, value)
  },
}))

import { initLanguage } from '../language'
import { getLocale } from '@/i18n'

describe('English UI startup with older saved preferences', () => {
  beforeEach(() => {
    state.values.clear()
    state.readFails = false
    state.writeFails = false
    state.writes = []
    vi.stubGlobal('document', { documentElement: { lang: '' } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('normalizes a retired saved UI language without touching other settings', async () => {
    state.values.set('ui.language', 'zh-CN')
    state.values.set('cloudAsr.language', 'de')
    await initLanguage()
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(state.values.get('ui.language')).toBe('en')
    expect(state.values.get('cloudAsr.language')).toBe('de')
    expect(state.writes).toEqual([['ui.language', 'en']])
  })

  it('does not rewrite an English setting', async () => {
    state.values.set('ui.language', 'en')
    await initLanguage()
    expect(state.writes).toEqual([])
  })

  it('keeps the English UI usable if settings are inaccessible', async () => {
    state.readFails = true
    await expect(initLanguage()).resolves.toBeUndefined()
    expect(document.documentElement.lang).toBe('en')
    state.readFails = false
    state.values.set('ui.language', 'unknown')
    state.writeFails = true
    await expect(initLanguage()).resolves.toBeUndefined()
    expect(document.documentElement.lang).toBe('en')
  })
})
