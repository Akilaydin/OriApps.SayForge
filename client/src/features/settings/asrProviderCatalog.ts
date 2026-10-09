//
//
//

import { t } from '@/i18n'

export type AsrPlatform = 'openai_compat'

export interface AsrPlatformInfo {
  label: string
  consoleUrl: string
}

export const ASR_PLATFORMS: Record<AsrPlatform, AsrPlatformInfo> = {
  openai_compat: {
    get label() { return t('asrPlatform.openaiCompat') },
    consoleUrl: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
  },
}

export type AsrCompatProtocol = 'auto' | 'transcriptions' | 'chat' | 'chat_standard'

export type AsrAudioEncoding = 'wav' | 'mp3'

export function parseAsrAudioEncoding(value: unknown): AsrAudioEncoding {
  return value === 'mp3' ? 'mp3' : 'wav'
}

export const ASR_COMPAT_PROTOCOLS: AsrCompatProtocol[] = ['auto', 'transcriptions', 'chat', 'chat_standard']

export function parseAsrCompatProtocol(value: unknown): AsrCompatProtocol {
  return value === 'transcriptions' || value === 'chat' || value === 'chat_standard' ? value : 'auto'
}

export interface AsrModelOption {
  id: string
  provider: string
  apiModel?: string
  //
  //
  blurb?: string
  omni?: boolean
  needsWorkspaceId?: boolean
  supportsCustomUrl?: boolean
  requiresCustomUrl?: boolean
}

export interface AsrProviderEntry {
  id: string
  label: string
  platform: AsrPlatform
  blurb: string
  availability: 'mainland_china' | 'global'
  models: AsrModelOption[]
  customEndpoint?: boolean
  urlPlaceholder?: string
}

export const ASR_PROVIDERS: AsrProviderEntry[] = [
  {
    id: 'openai_compat',
    get label() { return t('asrProvider.openaiCompat') },
    platform: 'openai_compat',
    availability: 'global',
    customEndpoint: true,
    urlPlaceholder: 'http://127.0.0.1:8000/v1',
    get blurb() { return t('asrProvider.openaiCompatBlurb') },
    models: [{
      id: 'whisper-1',
      provider: 'openai_compat',
      supportsCustomUrl: true,
      requiresCustomUrl: true,
    }],
  },
]

export function asrModelsOf(entry: AsrProviderEntry): AsrModelOption[] {
  return entry.models
}


const LEGACY_PROVIDERS: Record<string, { provider: string; model: string }> = {
  groq: { provider: 'openai_compat', model: 'whisper-large-v3-turbo' },
  groq_whisper: { provider: 'openai_compat', model: 'whisper-large-v3-turbo' },
  openai: { provider: 'openai_compat', model: 'gpt-transcribe' },
  openai_transcribe: { provider: 'openai_compat', model: 'gpt-transcribe' },
  openai_compat_transcribe: { provider: 'openai_compat', model: 'whisper-1' },
  openai_chat_audio: { provider: 'openai_compat', model: 'whisper-1' },
  openai_chat_audio_standard: { provider: 'openai_compat', model: 'whisper-1' },
}

const LEGACY_PROTOCOLS: Record<string, AsrCompatProtocol> = {
  openai_compat_transcribe: 'transcriptions',
  openai_chat_audio: 'chat',
  openai_chat_audio_standard: 'chat_standard',
}

const LEGACY_URLS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  groq_whisper: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  openai_transcribe: 'https://api.openai.com/v1',
}

/** Normalize stored provider keys to the supported catalog. */
function migrateLegacyProvider(
  provider: string,
  model: string,
): { provider: string; model: string } | null {
  //
  //
  const trimmed = model.trim()
  const direct = findAsrProvider(provider)
  const belongsTo = (entry: AsrProviderEntry) =>
    trimmed !== '' && asrModelsOf(entry).some((m) => m.id === trimmed)

  if (direct && belongsTo(direct)) return { provider, model: trimmed }
  // Custom endpoints accept arbitrary model IDs. A saved user model must never
  // be replaced by the catalog's illustrative whisper-1 default on reload.
  if (direct?.customEndpoint && trimmed) return { provider, model: trimmed }

  const legacy = LEGACY_PROVIDERS[provider]
  if (legacy) {
    const card = findAsrProvider(legacy.provider)
    return {
      provider: legacy.provider,
      model: card && (belongsTo(card) || (card.customEndpoint && trimmed)) ? trimmed : legacy.model,
    }
  }

  if (direct) return { provider, model: asrModelsOf(direct)[0].id }
  return null
}

export function asrCardIdOfLegacyProvider(provider: string): string {
  return LEGACY_PROVIDERS[provider]?.provider ?? provider
}

export function groupAsrModelsByVendor(
  models: AsrModelOption[],
): [string, AsrModelOption[]][] | null {
  if (models.length < 2 || !models.every((m) => m.id.includes('/'))) return null
  const groups: [string, AsrModelOption[]][] = []
  for (const model of models) {
    const vendor = model.id.slice(0, model.id.indexOf('/'))
    const existing = groups.find(([name]) => name === vendor)
    if (existing) existing[1].push(model)
    else groups.push([vendor, [model]])
  }
  return groups
}

export function findAsrProvider(id: string): AsrProviderEntry | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id)
}

export function asrAvailabilityLabel(entry: AsrProviderEntry): string {
  if (entry.customEndpoint) return ''
  switch (entry.availability) {
    case 'global': return t('asrProvider.regionGlobal')
    default: return ''
  }
}

export function asrEndpointUrl(profile: AsrProfile): string {
  if (!resolveAsrModelOption(profile)?.supportsCustomUrl) return ''
  return profile.apiUrl.trim()
}

export function asrEndpointHost(profile: AsrProfile): string {
  const url = asrEndpointUrl(profile)
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function providersOfPlatform(platform: AsrPlatform): AsrProviderEntry[] {
  return ASR_PROVIDERS.filter((p) => p.platform === platform)
}


export interface AsrCheck {
  ok: boolean
  at: number
  latencyMs?: number
  audioSec?: number
  reason?: string
}

function isFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseCheck(raw: unknown): AsrCheck | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  if (typeof v.ok !== 'boolean') return undefined
  const at = isFiniteNumber(v.at)
  if (at === undefined) return undefined
  return {
    ok: v.ok,
    at,
    latencyMs: isFiniteNumber(v.latencyMs),
    audioSec: isFiniteNumber(v.audioSec),
    reason: typeof v.reason === 'string' && v.reason ? v.reason : undefined,
  }
}


export interface AsrProfile {
  id: string
  provider: string
  name: string
  apiUrl: string
  protocol: AsrCompatProtocol
  /** OpenAI-compatible chat_standard: WAV by default; optionally MP3/64 kbps mono. */
  audioEncoding: AsrAudioEncoding
  /** OpenAI-compatible chat: override the built-in transcription system instruction. */
  systemInstruction: string
  /** OpenAI-compatible chat: optional user text alongside the input audio. */
  userPrompt: string
  model: string
  /** Key to the selected speech API; legacy vendor fields are retained for imported data. */
  apiKey: string
  /** Legacy ID, kept only for round-tripping imported profiles. */
  appId: string
  /** Legacy console flag, no longer used by supported providers. */
  console: 'new' | 'legacy'
  /** Legacy alternative key, not used by supported providers. */
  otherKey: string
  /** Legacy workspace ID, no longer used by supported providers. */
  workspaceId: string
  /** Legacy omni prompt, not used by supported providers. */
  omniPrompt: string
  check?: AsrCheck
}

export function makeAsrProfileId(): string {
  return `asr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function emptyAsrProfile(provider = ASR_PROVIDERS[0].id): AsrProfile {
  const entry = findAsrProvider(provider)
  return {
    id: makeAsrProfileId(),
    provider,
    name: '',
    apiUrl: '',
    protocol: 'auto',
    audioEncoding: 'wav',
    systemInstruction: '',
    userPrompt: '',
    model: entry ? asrModelsOf(entry)[0].id : '',
    apiKey: '',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function parseAsrProfiles(raw: unknown): AsrProfile[] {
  return parseAsrProfilesDetailed(raw).profiles
}

export function parseAsrProfilesDetailed(
  raw: unknown,
): { profiles: AsrProfile[]; orphans: unknown[] } {
  if (!Array.isArray(raw)) return { profiles: [], orphans: [] }
  const out: AsrProfile[] = []
  const orphans: unknown[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      orphans.push(item)
      continue
    }
    const v = item as Record<string, unknown>
    if (str(v.model) === 'gpt-live-transcribe') {
      orphans.push(item)
      continue
    }
    const migrated = migrateLegacyProvider(str(v.provider), str(v.model))
    if (!migrated || !findAsrProvider(migrated.provider)) {
      orphans.push(item)
      continue
    }
    const { provider, model } = migrated
    const id = str(v.id) || makeAsrProfileId()
    if (seen.has(id)) {
      orphans.push(item)
      continue
    }
    seen.add(id)
    const consoleRaw = str(v.console)
    out.push({
      id,
      provider,
      name: str(v.name),
      apiUrl: str(v.apiUrl) || LEGACY_URLS[str(v.provider)] || '',
      protocol: LEGACY_URLS[str(v.provider)] && (!v.protocol || v.protocol === 'auto')
        ? 'transcriptions' : (!v.protocol || v.protocol === 'auto')
          ? LEGACY_PROTOCOLS[str(v.provider)] ?? 'auto' : parseAsrCompatProtocol(v.protocol),
      audioEncoding: parseAsrAudioEncoding(v.audioEncoding),
      systemInstruction: str(v.systemInstruction),
      userPrompt: str(v.userPrompt),
      model,
      apiKey: str(v.apiKey),
      appId: str(v.appId),
      console: consoleRaw === 'legacy' ? 'legacy' : 'new',
      otherKey: str(v.otherKey),
      workspaceId: str(v.workspaceId),
      omniPrompt: str(v.omniPrompt),
      check: parseCheck(v.check),
    })
  }
  return { profiles: out, orphans }
}

export function resolveAsrModelOption(profile: AsrProfile): AsrModelOption | undefined {
  const entry = findAsrProvider(profile.provider)
  if (!entry) return undefined
  const models = asrModelsOf(entry)
  const picked = profile.model.trim()
  const found = models.find((m) => m.id === picked)
  if (found) return found
  if (entry.customEndpoint && picked) return { ...models[0], id: picked }
  return models[0]
}

export function resolveAsrModel(profile: AsrProfile): string {
  return resolveAsrModelOption(profile)?.id ?? ''
}

export function resolveAsrRuntimeProvider(profile: AsrProfile): string {
  return resolveAsrModelOption(profile)?.provider ?? ''
}

export function resolveAsrApiModel(profile: AsrProfile): string {
  const option = resolveAsrModelOption(profile)
  if (!option) return ''
  return option.apiModel ?? option.id
}

export function resolveActiveAsrProfile(
  profiles: AsrProfile[],
  activeId: string,
): AsrProfile | null {
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null
}

export function effectiveAsrCredentials(profile: AsrProfile): { apiKey: string; appId: string } {
  return { apiKey: profile.apiKey.trim(), appId: '' }
}

/** Return which required credentials or endpoint are missing. */
export function describeAsrMissing(profile: AsrProfile): string {
  if (resolveAsrModelOption(profile)?.requiresCustomUrl) {
    if (!profile.apiUrl.trim()) return t('asrProvider.missingUrl')
    return ''
  }
  return profile.apiKey.trim() ? '' : t('asrProvider.missingKey')
}

export function asrCardTitle(profile: AsrProfile, siblings: number): string {
  const named = profile.name.trim()
  if (named) return named
  const entry = findAsrProvider(profile.provider)
  const base = entry?.label ?? profile.provider
  if (siblings <= 1) return base
  const host = asrEndpointHost(profile)
  return host ? `${base} · ${host}` : base
}


export type AsrLatencyTier = 'instant' | 'fast' | 'normal' | 'slow' | 'tooSlow'

export interface AsrLatencyGrade {
  tier: AsrLatencyTier
  label: string
  tone: 'ok' | 'warn' | 'bad'
}

const RTF_THRESHOLDS = { instant: 0.15, fast: 0.3, normal: 0.5, slow: 0.8 } as const

export function gradeAsrLatency(latencyMs: number, audioSec: number): AsrLatencyGrade {
  if (!Number.isFinite(audioSec) || audioSec <= 0) {
    return { tier: 'normal', label: t('grade.tested'), tone: 'ok' }
  }
  const rtf = latencyMs / (audioSec * 1000)
  if (rtf < RTF_THRESHOLDS.instant) return { tier: 'instant', label: t('grade.instant'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.fast) return { tier: 'fast', label: t('grade.fast'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.normal) return { tier: 'normal', label: t('grade.normal'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.slow) return { tier: 'slow', label: t('grade.slow'), tone: 'warn' }
  return { tier: 'tooSlow', label: t('grade.tooSlow'), tone: 'bad' }
}
