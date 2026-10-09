import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initLanguage } from '../language'
import { getLocale } from '@/i18n'

describe('English-only UI startup', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: { lang: '' } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sets the English document language without accessing persisted preferences', () => {
    initLanguage()
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
