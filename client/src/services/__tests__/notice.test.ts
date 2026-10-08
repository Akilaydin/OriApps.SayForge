import { describe, expect, it } from 'vitest'
import { normalizeRemoteNotice } from '../notice'

const base = { id: 'notice-1', level: 'info' as const }

describe('normalizeRemoteNotice', () => {
  it('keeps legacy single-language notices compatible', () => {
    const result = normalizeRemoteNotice({ ...base, title: 'Legacy notice', body: 'Legacy content' }, 'en')
    expect(result?.title).toBe('Legacy notice')
    expect(result?.body).toBe('Legacy content')
  })

  it('selects title, body, and link label for the active locale', () => {
    const payload = {
      ...base,
      title: 'Default notice',
      body: 'Default content',
      linkLabel: 'View details',
      translations: {
        en: {
          title: 'Maintenance notice',
          body: 'Maintenance tonight',
          linkLabel: 'Learn more',
        },
      },
    }
    expect(normalizeRemoteNotice(payload, 'en')).toMatchObject({
      title: 'Maintenance notice',
      body: 'Maintenance tonight',
      linkLabel: 'Learn more',
    })
  })

  it('falls back field by field to legacy strings', () => {
    const result = normalizeRemoteNotice({
      ...base,
      title: 'Fallback title',
      body: 'Fallback body',
      translations: { en: { title: 'English title' } },
    }, 'en')
    expect(result?.title).toBe('English title')
    expect(result?.body).toBe('Fallback body')
  })

  it('rejects payloads without any usable title', () => {
    expect(normalizeRemoteNotice({ ...base, title: '', translations: { en: { title: 'English' } } }, 'en')).toBeNull()
  })
})
