//

import { getLocale, t } from '@/i18n'

export interface AiProvider {
  value: string
  label: string
  defaultUrl: string
  defaultModels: string[]
  keyless?: boolean
  consoleUrl?: string
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    value: 'openai_compat',
    get label() { return t('aiProvider.openaiCompat') },
    defaultUrl: 'https://api.openai.com',
    defaultModels: ['gpt-4o-mini'],
  },
]

export function preferredAiProviderValue(): string {
  return 'openai_compat'
}

export function aiProvidersForDisplay(): AiProvider[] {
  const preferred = preferredAiProviderValue()
  if (AI_PROVIDERS[0]?.value === preferred) return AI_PROVIDERS
  return [
    ...AI_PROVIDERS.filter((provider) => provider.value === preferred),
    ...AI_PROVIDERS.filter((provider) => provider.value !== preferred),
  ]
}

export function findProvider(value: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.value === value) ?? AI_PROVIDERS[0]
}

export type AiSettingField = 'apiUrl' | 'apiKey' | 'model' | 'models' | 'latency'

export function aiSettingKey(provider: string, field: AiSettingField): string {
  return `cloudAi.${provider}.${field}`
}

export function providerLabel(value: string): string {
  return AI_PROVIDERS.find((p) => p.value === value)?.label ?? value
}

export interface AiProfileCheck {
  ok: boolean
  at?: number
  latencyMs?: number
  reason?: string
}

export interface AiProfile {
  id: string
  provider: string
  apiUrl: string
  apiKey: string
  model: string
  check?: AiProfileCheck
}

export function makeProfileId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function blankProfile(providerValue = preferredAiProviderValue()): AiProfile {
  const meta = findProvider(providerValue)
  return {
    id: makeProfileId(),
    provider: meta.value,
    apiUrl: meta.defaultUrl,
    apiKey: '',
    model: meta.defaultModels[0] ?? '',
  }
}

function profileCustomHost(profile: AiProfile): string {
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host
    } catch {
      return url.trim()
    }
  }
  const host = hostOf(profile.apiUrl)
  const defaultHost = hostOf(findProvider(profile.provider).defaultUrl)
  return host && host !== defaultHost ? host : ''
}

export function profileSubtitle(profile: AiProfile): string {
  const label = providerLabel(profile.provider)
  const host = profileCustomHost(profile)
  return host ? `${label} · ${host}` : label
}

export function profileTitle(profile: AiProfile): string {
  return profile.model.trim() || t('aiProvider.noModel')
}

export function isProfileComplete(profile: AiProfile): boolean {
  if (!profile.apiUrl.trim() || !profile.model.trim()) return false
  if (!findProvider(profile.provider).keyless && !profile.apiKey.trim()) return false
  return true
}

export function parseProfiles(raw: unknown): AiProfile[] {
  if (!Array.isArray(raw)) return []
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const used = new Set<string>()
  const out: AiProfile[] = []

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const source = item as Record<string, unknown>

    let id = text(source.id).trim() || `recovered-${index}`
    while (used.has(id)) id = `${id}-${index}`
    used.add(id)

    out.push({
      id,
      provider: text(source.provider) === 'groq' ? 'openai_compat' : text(source.provider) || AI_PROVIDERS[0].value,
      apiUrl: text(source.apiUrl),
      apiKey: text(source.apiKey),
      model: text(source.model),
      check: parseCheck(source.check, source.latencyMs, finite),
    })
  })

  return out
}

/** Unsupported profiles are retained unchanged in storage, including their keys.
 * They must not be shown as if a removed provider were a supported one.
 */
export function parseProfilesDetailed(raw: unknown): {
  profiles: AiProfile[]
  orphans: unknown[]
} {
  if (!Array.isArray(raw)) return { profiles: [], orphans: [] }
  const supported: unknown[] = []
  const orphans: unknown[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      orphans.push(item)
      continue
    }
    const provider = (item as Record<string, unknown>).provider
    if (typeof provider === 'string' && provider && provider !== 'groq' && !AI_PROVIDERS.some((p) => p.value === provider)) {
      orphans.push(item)
    } else {
      supported.push(item)
    }
  }
  return { profiles: parseProfiles(supported), orphans }
}

function parseCheck(
  raw: unknown,
  legacyLatency: unknown,
  finite: (value: unknown) => number | undefined,
): AiProfileCheck | undefined {
  if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>
    if (typeof source.ok === 'boolean') {
      const reason = typeof source.reason === 'string' ? source.reason.trim() : ''
      return {
        ok: source.ok,
        at: finite(source.at),
        latencyMs: finite(source.latencyMs),
        reason: reason || undefined,
      }
    }
  }
  const latency = finite(legacyLatency)
  return latency === undefined ? undefined : { ok: true, latencyMs: latency }
}

export function resolveActiveProfile(profiles: AiProfile[], activeId: string): AiProfile | null {
  if (profiles.length === 0) return null
  return profiles.find((p) => p.id === activeId) ?? profiles[0]
}

export function checkAiKeyFormat(provider: string, key: string): string {
  if (!key.trim()) return ''
  if (/\s/.test(key)) {
    return t('aiProvider.keyHasSpace')
  }
  return ''
}

export function checkApiUrl(url: string): string {
  const u = url.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) {
    return t('aiProvider.urlNeedsScheme')
  }
  try {
    const parsed = new URL(u)
    if (!parsed.hostname) return t('aiProvider.urlInvalid')
  } catch {
    return t('aiProvider.urlInvalid')
  }
  return ''
}

export function extractTestReply(detail?: string): string {
  // The native connection test returns a structured detail block.
  // Older builds may label its response using a localized field name.
  return detail?.match(/^(?:Reply|Response):\s*(.*)$/mi)?.[1]?.trim() ?? ''
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export type LatencyTier = 'instant' | 'fast' | 'normal' | 'slow' | 'tooSlow'

export interface LatencyGrade {
  tier: LatencyTier
  label: string
  tone: 'ok' | 'warn' | 'bad'
}

const LATENCY_THRESHOLDS = { instant: 200, fast: 500, normal: 1000, slow: 2000 } as const

export function gradeLatency(ms: number): LatencyGrade {
  if (ms < LATENCY_THRESHOLDS.instant) return { tier: 'instant', label: t('grade.instant'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.fast) return { tier: 'fast', label: t('grade.fast'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.normal) return { tier: 'normal', label: t('grade.normal'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.slow) return { tier: 'slow', label: t('grade.slow'), tone: 'warn' }
  return { tier: 'tooSlow', label: t('grade.tooSlow'), tone: 'bad' }
}

export const CHECK_FRESH_MS = 24 * 60 * 60 * 1000

export function isCheckFresh(check: AiProfileCheck | undefined, now = Date.now()): boolean {
  if (!check?.at) return false
  return now - check.at < CHECK_FRESH_MS
}

export function formatCheckedAt(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return t('time.justNow')
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return rtf.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.floor(hours / 24), 'day')
}


export interface LegacyProviderData {
  provider: string
  apiUrl: string
  apiKey: string
  model: string
  models: string[]
  latencies: Record<string, number>
}

export function parseLegacyLatencies(raw: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of raw.split(',')) {
    const [name, ms] = part.split('=')
    const value = Number(ms)
    if (name?.trim() && ms !== undefined && ms !== '' && Number.isFinite(value)) {
      out[name.trim()] = value
    }
  }
  return out
}

export function migrateLegacyProfiles(
  legacy: LegacyProviderData[],
  activeProvider: string,
  activeModel: string,
): { profiles: AiProfile[]; activeId: string } {
  const profiles: AiProfile[] = []

  for (const entry of legacy) {
    const provider = entry.provider === 'groq' ? 'openai_compat' : entry.provider
    const meta = AI_PROVIDERS.find((p) => p.value === provider)
    if (!meta) continue
    const url = entry.apiUrl.trim() || (entry.provider === 'groq' ? 'https://api.groq.com/openai/v1' : meta.defaultUrl)
    if (!url) continue
    if (!meta.keyless && !entry.apiKey.trim()) continue

    const models = [...entry.models]
    if (entry.model && !models.includes(entry.model)) models.unshift(entry.model)
    const unique = models.map((m) => m.trim()).filter(Boolean).filter((m, i, a) => a.indexOf(m) === i)
    if (unique.length === 0) continue

    for (const model of unique) {
      const latencyMs = entry.latencies[model]
      profiles.push({
        id: `legacy-${entry.provider}-${model}`,
        provider,
        apiUrl: url,
        apiKey: entry.apiKey,
        model,
        check: latencyMs === undefined ? undefined : { ok: true, latencyMs },
      })
    }
  }

  const matched = profiles.find((p) => p.provider === (activeProvider === 'groq' ? 'openai_compat' : activeProvider) && p.model === activeModel)
    ?? profiles.find((p) => p.provider === activeProvider)
    ?? profiles[0]

  return { profiles, activeId: matched?.id ?? '' }
}
