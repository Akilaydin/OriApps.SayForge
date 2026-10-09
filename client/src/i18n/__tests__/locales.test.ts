import { describe, expect, it } from 'vitest'
import en from '../locales/en.json'
import { getLocale, isLocale, setLocale, t } from '..'
import {
  historyFailureReasonDisplay,
  promptPresetDisplayName, recordedAppDisplayName, recordedPromptPresetDisplayName,
} from '../displayNames'

describe('English-only UI locale', () => {
  it('accepts only the English UI locale', () => {
    expect(isLocale('en')).toBe(true)
    for (const unsupported of ['fr', 'de-DE', null]) expect(isLocale(unsupported)).toBe(false)
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
