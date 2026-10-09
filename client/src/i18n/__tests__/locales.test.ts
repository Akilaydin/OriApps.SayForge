import { describe, expect, it } from 'vitest'
import en from '../locales/en.json'
import { getLocale, isLocale, normalizePreference, resolveLocale, setLocale, t, LOCALES } from '..'
import {
  historyFailureReasonDisplay,
  promptPresetDisplayName, recordedAppDisplayName, recordedPromptPresetDisplayName,
} from '../displayNames'

describe('English-only UI locale', () => {
  it('has only one supported locale and rejects old language settings', () => {
    expect(LOCALES).toEqual(['en'])
    expect(isLocale('en')).toBe(true)
    for (const legacy of ['zh-CN', 'zh', 'de-DE', null]) expect(isLocale(legacy)).toBe(false)
    expect(resolveLocale('zh-CN')).toBe('en')
    expect(resolveLocale('ru-RU')).toBe('en')
    expect(normalizePreference('zh-CN')).toBe('en')
    expect(normalizePreference('auto')).toBe('auto')
    setLocale('en')
    expect(getLocale()).toBe('en')
  })
  it('provides nonempty English strings and interpolates placeholders', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe('')
    }
    expect(t('nav.home')).toBe(en['nav.home'])
    expect(t('titleBar.presetTooltip', { name: 'Faithful' }))
      .toBe(en['titleBar.presetTooltip'].replace('{name}', 'Faithful'))
    expect(t('titleBar.presetTooltip')).toContain('{name}')
  })
  it('keeps builtin and user-provided display names', () => {
    expect(promptPresetDisplayName({ id: 'intent', name: 'old', builtin: true }))
      .toBe(en['builtinPreset.intent'])
    expect(recordedPromptPresetDisplayName('intent', 'old')).toBe(en['builtinPreset.intent'])
    expect(recordedAppDisplayName('notepad', 'old')).toBe(en['builtinApp.notepad'])
    expect(promptPresetDisplayName({ id: 'custom', name: 'My preset', builtin: false }))
      .toBe('My preset')
    expect(recordedAppDisplayName('custom', 'Custom name')).toBe('Custom name')
  })
  it('formats stable history failure codes and preserves legacy reasons', () => {
    expect(historyFailureReasonDisplay({ failReasonCode: 'provider_bad_key', failReason: 'old' }))
      .toBe(en['err.provider.badKey'])
    expect(historyFailureReasonDisplay({ failReason: 'Old failure text' })).toBe('Old failure text')
  })
})
