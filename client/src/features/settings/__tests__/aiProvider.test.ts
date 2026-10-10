import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  blankProfile,
  checkAiKeyFormat,
  checkApiUrl,
  extractTestReply,
  formatCheckedAt,
  formatLatency,
  gradeLatency,
  isCheckFresh,
  isProfileComplete,
  migrateLegacyProfiles,
  parseLegacyLatencies,
  parseProfiles,
  profileSubtitle,
  profileTitle,
  preferredAiProviderValue,
  resolveActiveProfile,
  type AiProfile,
  type LegacyProviderData,
} from '../aiProviderCatalog'

describe('AI_PROVIDERS catalog', () => {
  it('each provider has a default URL and candidate models', () => {
    for (const p of AI_PROVIDERS) {
      expect(p.defaultUrl, `${p.value} has no default URL`).toMatch(/^https?:\/\//)
      expect(p.defaultModels.length, `${p.value} has no candidate models`).toBeGreaterThan(0)
      for (const m of p.defaultModels) expect(m.trim()).not.toBe('')
    }
  })

  it('provider values are unique', () => {
    const values = AI_PROVIDERS.map((p) => p.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('exposes only the compatible AI endpoint', () => {
    expect(AI_PROVIDERS.filter((p) => p.keyless).map((p) => p.value)).toEqual([])
  })
})

describe('provider defaults', () => {
  it('prefers OpenAI-compatible', () => {
    expect(preferredAiProviderValue()).toBe('openai_compat')
    expect(blankProfile().provider).toBe('openai_compat')
  })
})

describe('checkAiKeyFormat', () => {
  it('accepts an empty key', () => {
    expect(checkAiKeyFormat('deepseek', '')).toBe('')
  })

  it('warns about pasted whitespace', () => {
    expect(checkAiKeyFormat('openai_compat', 'sk-abc def')).toContain('space')
    expect(checkAiKeyFormat('openai_compat', 'abc\ndef')).toContain('space')
  })

  it('accepts API keys with arbitrary lengths and formats for compatible services', () => {
    expect(checkAiKeyFormat('openai_compat', 'provider-specific-key')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'sk-abc')).toBe('')
  })

  it('does not assume provider key length', () => {
    expect(checkAiKeyFormat('openai_compat', 'sk-' + 'a'.repeat(64))).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'sk-abc')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'not-a-uuid-at-all')).toBe('')
  })

  it('providers without specific rules only check whitespace', () => {
    expect(checkAiKeyFormat('openai_compat', 'whatever-key')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'anything')).toBe('')
  })
})

describe('checkApiUrl', () => {
  it('empty URLs are validated on submit', () => {
    expect(checkApiUrl('')).toBe('')
  })

  it('warns when the URL scheme is missing', () => {
    expect(checkApiUrl('api.deepseek.com')).toContain('http')
  })

  it('accepts HTTP and HTTPS', () => {
    expect(checkApiUrl('https://api.deepseek.com')).toBe('')
    expect(checkApiUrl('http://127.0.0.1:11434')).toBe('')
  })

  it('warns about an invalid URL', () => {
    expect(checkApiUrl('https://')).toContain('valid URL')
  })
})

describe('extractTestReply', () => {
  const backendDetail = [
    'Elapsed: 1240ms',
    'Model: gpt-4o-mini',
    'Sent: system="Reply with OK only." user="Connection test"',
    'Reply: OK',
  ].join('\n')

  it('extracts reply without exposing the internal test prompt', () => {
    expect(extractTestReply(backendDetail)).toBe('OK')
    expect(extractTestReply(backendDetail)).not.toContain('system=')
  })

  it('returns empty if there is no reply line', () => {
    expect(extractTestReply('Elapsed: 5ms')).toBe('')
    expect(extractTestReply(undefined)).toBe('')
  })
})

describe('formatLatency', () => {
  it('formats subsecond latency as milliseconds', () => {
    expect(formatLatency(840)).toBe('840ms')
    expect(formatLatency(1240)).toBe('1.2s')
  })
})

describe('parseLegacyLatencies', () => {
  it('parses model=ms latency entries', () => {
    expect(parseLegacyLatencies('model-alpha=1240,model-beta=2380')).toEqual({
      'model-alpha': 1240,
      'model-beta': 2380,
    })
  })

  it('ignores malformed latency entries without throwing', () => {
    expect(parseLegacyLatencies('a=1,,broken,b=x,c=3')).toEqual({ a: 1, c: 3 })
    expect(parseLegacyLatencies('')).toEqual({})
  })
})

function profile(patch: Partial<AiProfile> = {}): AiProfile {
  return {
    id: 'p1',
    provider: 'openai_compat',
    apiUrl: 'https://api.openai.com',
    apiKey: 'sk-key',
    model: 'gpt-4o-mini',
    ...patch,
  }
}

describe('parseProfiles', () => {
  it('normalizes non-array imports to an empty list', () => {
    expect(parseProfiles(null)).toEqual([])
    expect(parseProfiles('[]')).toEqual([])
    expect(parseProfiles({ profiles: [] })).toEqual([])
  })

  it('discards invalid entries and preserves recoverable objects', () => {
    const result = parseProfiles([profile(), 'junk', null, 42])
    expect(result).toHaveLength(1)
    expect(result[0].model).toBe('gpt-4o-mini')
  })

  it('fills missing fields and defaults the provider', () => {
    const [entry] = parseProfiles([{ id: 'x' }])
    expect(entry).toEqual({
      id: 'x',
      provider: AI_PROVIDERS[0].value,
      apiUrl: '',
      apiKey: '',
      model: '',
      latencyMs: undefined,
    })
  })

  it('repairs missing and duplicate profile IDs', () => {
    const ids = parseProfiles([{ model: 'a' }, { model: 'b' }, { id: 'same' }, { id: 'same' }])
      .map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('restores checks only with boolean outcomes', () => {
    const ok = parseProfiles([profile({ check: { ok: true, at: 1000, latencyMs: 1200 } })])[0].check
    expect(ok).toEqual({ ok: true, at: 1000, latencyMs: 1200, reason: undefined })

    const failed = parseProfiles([profile({ check: { ok: false, at: 1000, reason: 'Key rejected' } })])[0].check
    expect(failed?.ok).toBe(false)
    expect(failed?.reason).toBe('Key rejected')

    expect(parseProfiles([{ ...profile(), check: { latencyMs: 1200 } }])[0].check).toBeUndefined()
    expect(parseProfiles([{ ...profile(), check: 'ok' }])[0].check).toBeUndefined()
  })

  it('migrates legacy latency to a successful check', () => {
    const upgraded = parseProfiles([{ ...profile(), check: undefined, latencyMs: 1200 }])[0].check
    expect(upgraded).toEqual({ ok: true, latencyMs: 1200 })
    expect(upgraded?.at).toBeUndefined()
  })

  it('ignores invalid latency', () => {
    expect(parseProfiles([{ ...profile(), latencyMs: 'fast' }])[0].check).toBeUndefined()
    expect(parseProfiles([{ ...profile(), latencyMs: Number.NaN }])[0].check).toBeUndefined()
  })
})

describe('gradeLatency', () => {
  it('grades latency at 200/500/1000/2000 ms', () => {
    expect(gradeLatency(0).label).toBe('Instant')
    expect(gradeLatency(199).label).toBe('Instant')
    expect(gradeLatency(200).label).toBe('Fast')
    expect(gradeLatency(499).label).toBe('Fast')
    expect(gradeLatency(500).label).toBe('Normal')
    expect(gradeLatency(999).label).toBe('Normal')
    expect(gradeLatency(1000).label).toBe('Slow')
    expect(gradeLatency(1999).label).toBe('Slow')
    expect(gradeLatency(2000).label).toBe('Too slow')
  })

  it('labels every latency tier', () => {
    for (const ms of [80, 300, 700, 1500, 3000]) {
      expect(gradeLatency(ms).label).not.toBe('')
    }
  })

  it('uses bad tone only above two seconds', () => {
    expect(gradeLatency(150).tone).toBe('ok')
    expect(gradeLatency(980).tone).toBe('ok')
    expect(gradeLatency(1400).tone).toBe('warn')
    expect(gradeLatency(2000).tone).toBe('bad')
    expect(gradeLatency(9000).tone).toBe('bad')
  })
})

describe('isCheckFresh', () => {
  const now = new Date('2026-08-03T12:00:00Z').getTime()

  it('expires stale successful checks', () => {
    expect(isCheckFresh({ ok: true, at: now - 60 * 1000 }, now)).toBe(true)
    expect(isCheckFresh({ ok: true, at: now - 23 * 3600 * 1000 }, now)).toBe(true)
    expect(isCheckFresh({ ok: true, at: now - 25 * 3600 * 1000 }, now)).toBe(false)
    expect(isCheckFresh({ ok: true, at: now - 3 * 24 * 3600 * 1000 }, now)).toBe(false)
  })

  it('unknown check timestamps are stale', () => {
    expect(isCheckFresh(undefined, now)).toBe(false)
    expect(isCheckFresh({ ok: true, latencyMs: 300 }, now)).toBe(false)
  })
})

describe('formatCheckedAt', () => {
  const now = new Date('2026-08-03T12:00:00Z').getTime()

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  it('formats elapsed time at an appropriate granularity', () => {
    expect(formatCheckedAt(now - 30 * 1000, now)).toBe('just now')
    expect(formatCheckedAt(now - 5 * 60 * 1000, now)).toBe(rtf.format(-5, 'minute'))
    expect(formatCheckedAt(now - 3 * 3600 * 1000, now)).toBe(rtf.format(-3, 'hour'))
    expect(formatCheckedAt(now - 50 * 3600 * 1000, now)).toBe(rtf.format(-2, 'day'))
  })

  it('does not display negative time after clock rollback', () => {
    expect(formatCheckedAt(now + 60 * 1000, now)).toBe('just now')
  })
})

describe('resolveActiveProfile', () => {
  it('falls back to the first profile for a deleted ID', () => {
    const list = [profile({ id: 'a' }), profile({ id: 'b' })]
    expect(resolveActiveProfile(list, 'b')?.id).toBe('b')
    expect(resolveActiveProfile(list, 'deleted id')?.id).toBe('a')
    expect(resolveActiveProfile(list, '')?.id).toBe('a')
  })

  it('returns null for an empty profile list', () => {
    expect(resolveActiveProfile([], 'a')).toBeNull()
  })
})

describe('profile titles and subtitles', () => {
  it('shows a label when the model is missing', () => {
    expect(profileTitle(profile({ model: '  ' }))).toBe('no model set')
  })

  it('shows hosts only for custom endpoints', () => {
    expect(profileSubtitle(profile())).toBe('OpenAI-compatible')
    expect(profileSubtitle(profile({ provider: 'openai_compat', apiUrl: 'http://127.0.0.1:8000/v1' })))
      .toBe('OpenAI-compatible · 127.0.0.1:8000')
  })

  it('distinguishes two compatible endpoints', () => {
    const a = profile({ id: 'a', provider: 'openai_compat', apiUrl: 'https://api.openai.com', model: 'gpt-4o-mini' })
    const b = profile({ id: 'b', provider: 'openai_compat', apiUrl: 'http://192.168.1.9:8000/v1', model: 'gpt-4o-mini' })
    expect(profileSubtitle(a)).not.toBe(profileSubtitle(b))
  })
})

describe('isProfileComplete', () => {
  it('requires credentials and rejects retired keyless providers', () => {
    expect(isProfileComplete(profile({ apiKey: '' }))).toBe(false)
    expect(isProfileComplete(profile({ provider: 'ollama', apiKey: '', apiUrl: 'http://127.0.0.1:11434' }))).toBe(false)
  })

  it('requires both endpoint and model', () => {
    expect(isProfileComplete(profile({ apiUrl: '' }))).toBe(false)
    expect(isProfileComplete(profile({ model: ' ' }))).toBe(false)
    expect(isProfileComplete(profile())).toBe(true)
  })
})

describe('migrateLegacyProfiles', () => {
  const legacy: LegacyProviderData[] = [
    {
      provider: 'groq',
      apiUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-key',
      model: 'whisper-large-v3-turbo',
      models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
      latencies: { 'whisper-large-v3-turbo': 1200 },
    },
    { provider: 'deprecated-provider', apiUrl: '', apiKey: '', model: '', models: [], latencies: {} },
  ]

  it('migrates candidate models with credentials and latency', () => {
    const { profiles } = migrateLegacyProfiles(legacy, 'groq', 'whisper-large-v3')
    expect(profiles.map((p) => p.model)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
    expect(profiles.every((p) => p.apiKey === 'groq-key')).toBe(true)
    expect(profiles[0].check).toEqual({ ok: true, latencyMs: 1200 })
    expect(profiles[1].check).toBeUndefined()
  })

  it('preserves the legacy active provider/model', () => {
    const { profiles, activeId } = migrateLegacyProfiles(legacy, 'groq', 'whisper-large-v3')
    expect(resolveActiveProfile(profiles, activeId)?.model).toBe('whisper-large-v3')
  })

  it('skips incomplete legacy providers', () => {
    const { profiles } = migrateLegacyProfiles(legacy, 'groq', '')
    expect(profiles.some((p) => p.provider === 'deprecated-provider')).toBe(false)
  })

  it('new users migrate to an empty list', () => {
    const blank = AI_PROVIDERS.map((p) => ({
      provider: p.value, apiUrl: '', apiKey: '', model: '', models: [], latencies: {},
    }))
    const { profiles, activeId } = migrateLegacyProfiles(blank, '', '')
    expect(profiles).toEqual([])
    expect(activeId).toBe('')
  })

  it('repeated migration produces stable IDs', () => {
    const first = migrateLegacyProfiles(legacy, 'groq', '')
    const second = migrateLegacyProfiles(legacy, 'groq', '')
    expect(first.profiles.map((p) => p.id)).toEqual(second.profiles.map((p) => p.id))
  })
})
