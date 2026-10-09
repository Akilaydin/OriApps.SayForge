// Local storage service — Tauri IPC store

import * as bridge from './bridge'
import { BUILTIN_PROMPTS_EN } from './builtinPromptsEn'

const api = () => bridge

export interface HistoryListQuery {
  keyword?: string
  favoriteOnly?: boolean
  limit?: number
  offset?: number
}

export interface HistoryRecord {
  id: string
  timestamp: number
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  audioDurationSec?: number
  asrDurationSec?: number
  charCount: number
  favorite?: boolean
  isEmpty?: boolean  // true if no valid audio/text
  failReason?: string
  failReasonCode?: HistoryFailReasonCode
  audioFilePath?: string
  appId?: string
  appName?: string
  windowTitle?: string
  processName?: string
  windowClass?: string
  promptPresetId?: string
  promptPresetName?: string
  promptRuleId?: string
  promptSummary?: string
  styleSummary?: string
  autoAppliedHotwords?: string[]
  manualEditedAt?: number
  asrCorrectionId?: string | null
  asrCorrectionSubmittedAt?: number | null
  asrCorrectedText?: string | null
  workMode?: 'server' | 'cloud_api' | 'local'
  asrProvider?: string
  aiProvider?: string
  aiModel?: string
  aiSource?: 'server' | 'custom' | 'none'
  aiStatus?: 'applied' | 'skipped' | 'unavailable' | 'failed'
}

export type HistoryFailReasonCode =
  | 'no_transcript'
  | 'empty_after_processing'
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_bad_key'
  | 'provider_forbidden'
  | 'provider_rate_limit'
  | 'provider_no_model'
  | 'provider_failed'
  | 'processing_timeout'
  | 'connection_lost'

export interface Stats {
  totalDurationSec: number
  totalChars: number
}

export interface PromptPreset {
  id: string
  name: string
  systemPrompt: string
  builtin?: boolean  // built-in presets can't be deleted
  builtinPromptLanguage?: BuiltinPromptLanguage
  builtinPromptBaseHash?: string
  builtinPromptModified?: boolean
  builtinPromptUpdateAvailable?: boolean
}

export type BuiltinPromptLanguage = 'en'

export type FeedbackIssueType = 'asr_error' | 'llm_error' | 'duration_mismatch' | 'other'

export interface FeedbackRecord {
  id: string
  historyId: string
  createdAt: number
  issueType: FeedbackIssueType
  note: string
  status: 'pending_backend'
  snapshot: {
    asrText: string
    llmText: string
    asrMs: number
    llmMs: number
    durationSec: number
    audioDurationSec?: number
    asrDurationSec?: number
    charCount: number
    isEmpty?: boolean
  }
}

export interface ManualCorrectionRecord {
  id: string
  historyId?: string
  createdAt: number
  source: 'studio'
  appId?: string
  appName?: string
  promptSummary?: string
  preferredKind?: 'llm' | 'asr'
  originalAsrText: string
  originalLlmText: string
  editedAsrText: string
  editedLlmText: string
  preferredText: string
}

// Default English cleanup instruction for all builtin presets.
export const USER_PROMPT_PREFIX = 'Process the following speech transcript:\n\n'

const BUILTIN_PRESET_IDS = ['intent', 'faithful', 'casual'] as const
export const BUILTIN_PRESETS: PromptPreset[] = BUILTIN_PRESET_IDS.map((id) => ({
  id,
  name: { intent: 'Intent cleanup', faithful: 'Faithful cleanup', casual: 'Conversational cleanup' }[id],
  builtin: true,
  systemPrompt: BUILTIN_PROMPTS_EN[id],
}))

export function getBuiltinPromptPresets(_language: BuiltinPromptLanguage): PromptPreset[] {
  return BUILTIN_PRESETS.map((preset) => ({
    ...preset,
    builtinPromptLanguage: 'en',
  }))
}

export async function getHistory(): Promise<HistoryRecord[]> {
  return listHistory()
}

export async function listHistory(query: HistoryListQuery = {}): Promise<HistoryRecord[]> {
  try {
    const records = await api().historyList(query)
    return (records as HistoryRecord[]) || []
  } catch (err) {
    console.error('[store] listHistory FAILED:', err)
    return []
  }
}

export async function countHistory(query: Omit<HistoryListQuery, 'limit' | 'offset'> = {}): Promise<number> {
  try {
    const count = await api().historyCount(query)
    return count
  } catch (err) {
    console.error('[store] countHistory FAILED:', err)
    return 0
  }
}

export async function addHistory(record: HistoryRecord): Promise<void> {
  await api().historyAdd(record)
}

export async function deleteHistory(id: string): Promise<void> {
  await api().historyDelete(id)
}

export async function updateHistoryRecord(id: string, patch: Partial<HistoryRecord>): Promise<void> {
  await api().historyUpdate(id, patch as Record<string, unknown>)
}

export async function setHistoryFavorite(id: string, favorite: boolean): Promise<void> {
  await api().historySetFavorite(id, favorite)
}

export async function getFavoriteHistory(): Promise<HistoryRecord[]> {
  return listHistory({ favoriteOnly: true })
}

export async function getFeedbackQueue(): Promise<FeedbackRecord[]> {
  return ((await api().storeGet('feedbackQueue')) as FeedbackRecord[]) || []
}

export async function addFeedback(record: FeedbackRecord): Promise<void> {
  const queue = await getFeedbackQueue()
  queue.unshift(record)
  await api().storeSet('feedbackQueue', queue)
}

export async function getManualCorrections(): Promise<ManualCorrectionRecord[]> {
  return ((await api().storeGet('manualCorrections')) as ManualCorrectionRecord[]) || []
}

export async function addManualCorrection(record: ManualCorrectionRecord): Promise<void> {
  const corrections = await getManualCorrections()
  corrections.unshift(record)
  await api().storeSet('manualCorrections', corrections.slice(0, 200))
}

export async function getStats(): Promise<Stats> {
  try {
    const raw = await api().storeGet('stats')
    return (raw as Stats) || { totalDurationSec: 0, totalChars: 0 }
  } catch (err) {
    console.error('[store] getStats FAILED:', err)
    return { totalDurationSec: 0, totalChars: 0 }
  }
}

import { getDefault } from './defaults'

export async function getSetting<T>(key: string, fallback?: T): Promise<T> {
  const defaultValue = getDefault(key, fallback) as T
  const client = api()
  if (!client?.storeGet) {
    console.warn('[store] getSetting called before bridge is ready:', key)
    return defaultValue
  }
  const val = await client.storeGet(key)
  if (val === null || val === undefined) return defaultValue
  if (defaultValue !== null && defaultValue !== undefined) {
    const expectedType = typeof defaultValue
    if (expectedType === 'string' || expectedType === 'number' || expectedType === 'boolean') {
      if (typeof val !== expectedType) return defaultValue
    }
  }
  return val as T
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await api().storeSet(key, value)
}

// Prompt presets

export function normalizeBuiltinPromptLanguage(value: unknown): BuiltinPromptLanguage {
  return 'en'
}

export function builtinPromptContentHash(content: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export async function getBuiltinPromptLanguage(): Promise<BuiltinPromptLanguage> {
  return normalizeBuiltinPromptLanguage(await getSetting('ai.builtinPromptLanguage', 'en'))
}

export async function setBuiltinPromptLanguage(language: BuiltinPromptLanguage): Promise<void> {
  await setSetting('ai.builtinPromptLanguage', language)
}

function overrideLanguage(preset: PromptPreset): BuiltinPromptLanguage {
  return normalizeBuiltinPromptLanguage(preset.builtinPromptLanguage)
}

export async function getPromptPresets(languageOverride?: BuiltinPromptLanguage): Promise<PromptPreset[]> {
  let custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []
  const language = languageOverride ?? await getBuiltinPromptLanguage()
  const definitions = getBuiltinPromptPresets(language)
  const builtinIds = new Set(BUILTIN_PRESETS.map((preset) => preset.id))
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))

  const cleaned = custom.filter((candidate) => {
    if (!builtinIds.has(candidate.id) || overrideLanguage(candidate) !== language) return true
    return candidate.systemPrompt !== definitionById.get(candidate.id)?.systemPrompt
  })
  if (cleaned.length !== custom.length) {
    custom = cleaned
    await api().storeSet('promptPresets', custom)
  }

  const builtins = definitions.map((definition) => {
    const override = custom.find((candidate) => (
      candidate.id === definition.id && overrideLanguage(candidate) === language
    ))
    if (!override || override.systemPrompt === definition.systemPrompt) return definition
    const currentBaseHash = builtinPromptContentHash(definition.systemPrompt)
    return {
      ...definition,
      systemPrompt: override.systemPrompt,
      builtinPromptModified: true,
      builtinPromptUpdateAvailable: Boolean(
        override.builtinPromptBaseHash
        && override.builtinPromptBaseHash !== currentBaseHash
      ),
    }
  })

  const userCreated = custom.filter((c) => !builtinIds.has(c.id))

  return [...builtins, ...userCreated]
}

export async function getActivePresetId(): Promise<string> {
  return ((await api().storeGet('activePresetId')) as string) || 'intent'
}

export async function setActivePresetId(id: string): Promise<void> {
  await api().storeSet('activePresetId', id)
}

export async function getPresetShortcuts(): Promise<Record<string, string>> {
  return ((await api().storeGet('presetShortcuts')) as Record<string, string>) || {}
}

export async function setPresetShortcuts(map: Record<string, string>): Promise<void> {
  await api().storeSet('presetShortcuts', map)
}

export async function getActivePreset(): Promise<PromptPreset> {
  const id = await getActivePresetId()
  const all = await getPromptPresets()
  return all.find((p) => p.id === id) || all[0] || BUILTIN_PRESETS[0]
}

export async function savePromptPreset(preset: PromptPreset): Promise<void> {
  const custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []

  if (preset.builtin) {
    const language = preset.builtinPromptLanguage ?? await getBuiltinPromptLanguage()
    const definition = getBuiltinPromptPresets(language).find((item) => item.id === preset.id)
    if (!definition) return

    const withoutCurrentOverride = custom.filter((item) => !(
      item.id === preset.id && overrideLanguage(item) === language
    ))

    if (preset.systemPrompt !== definition.systemPrompt) {
      withoutCurrentOverride.push({
        id: preset.id,
        name: definition.name,
        systemPrompt: preset.systemPrompt,
        builtinPromptLanguage: language,
        builtinPromptBaseHash: builtinPromptContentHash(definition.systemPrompt),
      })
    }
    await api().storeSet('promptPresets', withoutCurrentOverride)
    return
  }

  const idx = custom.findIndex((p) => p.id === preset.id)

  const toSave = { ...preset }
  delete toSave.builtin
  delete toSave.builtinPromptLanguage
  delete toSave.builtinPromptBaseHash
  delete toSave.builtinPromptModified
  delete toSave.builtinPromptUpdateAvailable

  if (idx >= 0) {
    custom[idx] = toSave
  } else {
    custom.push(toSave)
  }
  await api().storeSet('promptPresets', custom)
}

export async function moveCustomPromptPreset(from: number, to: number): Promise<void> {
  const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id))
  const custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []
  const overrides = custom.filter((p) => builtinIds.has(p.id))
  const userCreated = custom.filter((p) => !builtinIds.has(p.id))

  if (from === to || from < 0 || to < 0 || from >= userCreated.length || to >= userCreated.length) return

  const [moved] = userCreated.splice(from, 1)
  userCreated.splice(to, 0, moved)

  await api().storeSet('promptPresets', [...overrides, ...userCreated])
}

export async function deletePromptPreset(id: string): Promise<void> {
  const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id))
  if (builtinIds.has(id)) return

  const custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []
  await api().storeSet('promptPresets', custom.filter((p) => p.id !== id))

  const activeId = await getActivePresetId()
  if (activeId === id) {
    await setActivePresetId('intent')
  }
}



