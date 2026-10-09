// Local storage service — Tauri IPC store

import * as bridge from './bridge'

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
