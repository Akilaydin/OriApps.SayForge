import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  aiProvidersForDisplay,
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
import { setLocale } from '@/i18n'

describe('AI_PROVIDERS 清单', () => {
  it('每家都有默认地址和至少一个候选模型', () => {
    for (const p of AI_PROVIDERS) {
      expect(p.defaultUrl, `${p.value} 缺默认地址`).toMatch(/^https?:\/\//)
      expect(p.defaultModels.length, `${p.value} 缺候选模型`).toBeGreaterThan(0)
      for (const m of p.defaultModels) expect(m.trim()).not.toBe('')
    }
  })

  it('value 唯一', () => {
    const values = AI_PROVIDERS.map((p) => p.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('只有 Ollama 是免密钥的本机服务', () => {
    expect(AI_PROVIDERS.filter((p) => p.keyless).map((p) => p.value)).toEqual(['ollama'])
  })
})

describe('地区相关的供应商默认值', () => {
  afterEach(() => setLocale('en'))

  it('英文界面优先 OpenAI-compatible', () => {
    setLocale('en')
    expect(preferredAiProviderValue()).toBe('openai_compat')
    expect(aiProvidersForDisplay()[0].value).toBe('openai_compat')
    expect(blankProfile().provider).toBe('openai_compat')
  })

  it('stays on international providers even for a legacy Chinese system preference', () => {
    expect(preferredAiProviderValue()).toBe('openai_compat')
    expect(aiProvidersForDisplay()[0].value).toBe('openai_compat')
    expect(blankProfile().provider).toBe('openai_compat')
  })
})

describe('checkAiKeyFormat', () => {
  it('空密钥不报警', () => {
    expect(checkAiKeyFormat('deepseek', '')).toBe('')
  })

  it('粘贴带进空白字符时报警', () => {
    expect(checkAiKeyFormat('openai_compat', 'sk-abc def')).toContain('space')
    expect(checkAiKeyFormat('openai_compat', 'abc\ndef')).toContain('space')
  })

  it('accepts API keys with arbitrary lengths and formats for compatible services', () => {
    expect(checkAiKeyFormat('openai_compat', 'provider-specific-key')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'sk-abc')).toBe('')
  })

  it('不再对长度做断言——供应商改长度不该让合法密钥报警', () => {
    expect(checkAiKeyFormat('openai_compat', 'sk-' + 'a'.repeat(64))).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'sk-abc')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'not-a-uuid-at-all')).toBe('')
  })

  it('没有专门规则的供应商只查空白字符', () => {
    expect(checkAiKeyFormat('openai_compat', 'whatever-key')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'anything')).toBe('')
  })
})

describe('checkApiUrl', () => {
  it('空地址不报警（由提交时统一处理）', () => {
    expect(checkApiUrl('')).toBe('')
  })

  it('缺协议前缀时报警', () => {
    expect(checkApiUrl('api.deepseek.com')).toContain('http')
  })

  it('接受 http 与 https', () => {
    expect(checkApiUrl('https://api.deepseek.com')).toBe('')
    expect(checkApiUrl('http://127.0.0.1:11434')).toBe('')
  })

  it('非法网址报警', () => {
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
  it('1 秒以内用 ms，超过用秒', () => {
    expect(formatLatency(840)).toBe('840ms')
    expect(formatLatency(1240)).toBe('1.2s')
  })
})

describe('parseLegacyLatencies', () => {
  it('解析 model=ms 串', () => {
    expect(parseLegacyLatencies('deepseek-v4-flash=1240,qwen-plus=2380')).toEqual({
      'deepseek-v4-flash': 1240,
      'qwen-plus': 2380,
    })
  })

  it('忽略损坏的条目，绝不抛异常', () => {
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
  it('非数组一律当空列表（导入了坏文件、手改坏了数据库）', () => {
    expect(parseProfiles(null)).toEqual([])
    expect(parseProfiles('[]')).toEqual([])
    expect(parseProfiles({ profiles: [] })).toEqual([])
  })

  it('丢掉不是对象的条目，保留能救的', () => {
    const result = parseProfiles([profile(), 'junk', null, 42])
    expect(result).toHaveLength(1)
    expect(result[0].model).toBe('gpt-4o-mini')
  })

  it('缺字段补空串、缺供应商回落到第一家', () => {
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

  it('id 缺失或重复都要修掉：单选和编辑都靠 id 定位，重复会让你点 A 改到 B', () => {
    const ids = parseProfiles([{ model: 'a' }, { model: 'b' }, { id: 'same' }, { id: 'same' }])
      .map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('读回检测结论；ok 不是布尔值就当没测过', () => {
    const ok = parseProfiles([profile({ check: { ok: true, at: 1000, latencyMs: 1200 } })])[0].check
    expect(ok).toEqual({ ok: true, at: 1000, latencyMs: 1200, reason: undefined })

    const failed = parseProfiles([profile({ check: { ok: false, at: 1000, reason: '密钥被拒绝' } })])[0].check
    expect(failed?.ok).toBe(false)
    expect(failed?.reason).toBe('密钥被拒绝')

    expect(parseProfiles([{ ...profile(), check: { latencyMs: 1200 } }])[0].check).toBeUndefined()
    expect(parseProfiles([{ ...profile(), check: 'ok' }])[0].check).toBeUndefined()
  })

  it('更早版本平铺的 latencyMs 升级成"测通过"的结论（老版本只有测通才写这个数）', () => {
    const upgraded = parseProfiles([{ ...profile(), check: undefined, latencyMs: 1200 }])[0].check
    expect(upgraded).toEqual({ ok: true, latencyMs: 1200 })
    expect(upgraded?.at).toBeUndefined()
  })

  it('脏的耗时不进结论', () => {
    expect(parseProfiles([{ ...profile(), latencyMs: 'fast' }])[0].check).toBeUndefined()
    expect(parseProfiles([{ ...profile(), latencyMs: Number.NaN }])[0].check).toBeUndefined()
  })
})

describe('gradeLatency', () => {
  it('五档，按口述场景的手感切：200 / 500 / 1000 / 2000', () => {
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

  it('每一档都有词：极速也要说出来，用户才知道这个数好不好', () => {
    for (const ms of [80, 300, 700, 1500, 3000]) {
      expect(gradeLatency(ms).label).not.toBe('')
    }
  })

  it('颜色分三档，2 秒以上才升到 bad（那是"别用"，不只是"慢"）', () => {
    expect(gradeLatency(150).tone).toBe('ok')
    expect(gradeLatency(980).tone).toBe('ok')
    expect(gradeLatency(1400).tone).toBe('warn')
    expect(gradeLatency(2000).tone).toBe('bad')
    expect(gradeLatency(9000).tone).toBe('bad')
  })
})

describe('isCheckFresh', () => {
  const now = new Date('2026-08-03T12:00:00Z').getTime()

  it('保鲜期内才算新鲜——过期的结论不该继续挂绿灯', () => {
    expect(isCheckFresh({ ok: true, at: now - 60 * 1000 }, now)).toBe(true)
    expect(isCheckFresh({ ok: true, at: now - 23 * 3600 * 1000 }, now)).toBe(true)
    expect(isCheckFresh({ ok: true, at: now - 25 * 3600 * 1000 }, now)).toBe(false)
    expect(isCheckFresh({ ok: true, at: now - 3 * 24 * 3600 * 1000 }, now)).toBe(false)
  })

  it('没测过、或不知道什么时候测的，都不算新鲜', () => {
    expect(isCheckFresh(undefined, now)).toBe(false)
    expect(isCheckFresh({ ok: true, latencyMs: 300 }, now)).toBe(false)
  })
})

describe('formatCheckedAt', () => {
  const now = new Date('2026-08-03T12:00:00Z').getTime()

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  it('按最粗的合适粒度说"多久之前"', () => {
    expect(formatCheckedAt(now - 30 * 1000, now)).toBe('just now')
    expect(formatCheckedAt(now - 5 * 60 * 1000, now)).toBe(rtf.format(-5, 'minute'))
    expect(formatCheckedAt(now - 3 * 3600 * 1000, now)).toBe(rtf.format(-3, 'hour'))
    expect(formatCheckedAt(now - 50 * 3600 * 1000, now)).toBe(rtf.format(-2, 'day'))
  })

  it('时钟往回跳时不说"负几分钟前"', () => {
    expect(formatCheckedAt(now + 60 * 1000, now)).toBe('just now')
  })
})

describe('resolveActiveProfile', () => {
  it('id 失效时回落到第一条，而不是"什么都没启用"', () => {
    const list = [profile({ id: 'a' }), profile({ id: 'b' })]
    expect(resolveActiveProfile(list, 'b')?.id).toBe('b')
    expect(resolveActiveProfile(list, '已删掉的 id')?.id).toBe('a')
    expect(resolveActiveProfile(list, '')?.id).toBe('a')
  })

  it('空列表返回 null', () => {
    expect(resolveActiveProfile([], 'a')).toBeNull()
  })
})

describe('一行的标题与副标题', () => {
  it('没填模型时也有字，否则那一行看着像坏了', () => {
    expect(profileTitle(profile({ model: '  ' }))).toBe('no model set')
  })

  it('默认地址不重复念，自定义端点才显示主机名', () => {
    expect(profileSubtitle(profile())).toBe('OpenAI-compatible')
    expect(profileSubtitle(profile({ provider: 'openai_compat', apiUrl: 'http://127.0.0.1:8000/v1' })))
      .toBe('OpenAI-compatible · 127.0.0.1:8000')
  })

  it('两个不同端点的 OpenAI 兼容在列表里能区分开——这正是旧结构做不到的事', () => {
    const a = profile({ id: 'a', provider: 'openai_compat', apiUrl: 'https://api.openai.com', model: 'gpt-4o-mini' })
    const b = profile({ id: 'b', provider: 'openai_compat', apiUrl: 'http://192.168.1.9:8000/v1', model: 'gpt-4o-mini' })
    expect(profileSubtitle(a)).not.toBe(profileSubtitle(b))
  })
})

describe('isProfileComplete', () => {
  it('免密钥的 Ollama 不要求密钥，其余都要', () => {
    expect(isProfileComplete(profile({ apiKey: '' }))).toBe(false)
    expect(isProfileComplete(profile({ provider: 'ollama', apiKey: '', apiUrl: 'http://127.0.0.1:11434' }))).toBe(true)
  })

  it('缺地址或缺模型都算没填完', () => {
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

  it('每个候选模型各成一条，带上原来的地址、密钥；有耗时的算测通过一次', () => {
    const { profiles } = migrateLegacyProfiles(legacy, 'groq', 'whisper-large-v3')
    expect(profiles.map((p) => p.model)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
    expect(profiles.every((p) => p.apiKey === 'groq-key')).toBe(true)
    expect(profiles[0].check).toEqual({ ok: true, latencyMs: 1200 })
    expect(profiles[1].check).toBeUndefined()
  })

  it('老的「当前供应商 + 当前模型」成为启用项', () => {
    const { profiles, activeId } = migrateLegacyProfiles(legacy, 'groq', 'whisper-large-v3')
    expect(resolveActiveProfile(profiles, activeId)?.model).toBe('whisper-large-v3')
  })

  it('没填完的供应商直接跳过', () => {
    const { profiles } = migrateLegacyProfiles(legacy, 'groq', '')
    expect(profiles.some((p) => p.provider === 'deprecated-provider')).toBe(false)
  })

  it('新用户（什么都没配过）迁出空列表，不是一堆空壳', () => {
    const blank = AI_PROVIDERS.map((p) => ({
      provider: p.value, apiUrl: '', apiKey: '', model: '', models: [], latencies: {},
    }))
    const { profiles, activeId } = migrateLegacyProfiles(blank, '', '')
    expect(profiles).toEqual([])
    expect(activeId).toBe('')
  })

  it('id 是确定性的：重复迁移不会产生两份', () => {
    const first = migrateLegacyProfiles(legacy, 'groq', '')
    const second = migrateLegacyProfiles(legacy, 'groq', '')
    expect(first.profiles.map((p) => p.id)).toEqual(second.profiles.map((p) => p.id))
  })
})
