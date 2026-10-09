import type { HistoryFailReasonCode, PromptPreset } from '@/services/store'
import { t, type TranslationKey } from '.'

const BUILTIN_PRESET_NAME_KEYS: Record<string, TranslationKey> = {
  intent: 'builtinPreset.intent',
  faithful: 'builtinPreset.faithful',
  casual: 'builtinPreset.casual',
}

const BUILTIN_APP_NAME_KEYS: Record<string, TranslationKey> = {
  teams: 'builtinApp.teams',
  outlook: 'builtinApp.outlook',
  kiro: 'builtinApp.kiro',
  vscode: 'builtinApp.vscode',
  cursor: 'builtinApp.cursor',
  notepad: 'builtinApp.notepad',
  codex: 'builtinApp.codex',
}

const HISTORY_FAILURE_KEYS: Record<HistoryFailReasonCode, TranslationKey> = {
  no_transcript: 'recorder.noTranscript',
  empty_after_processing: 'recorder.emptyAfterProcessing',
  provider_timeout: 'err.provider.timeout',
  provider_unreachable: 'err.provider.unreachable',
  provider_bad_key: 'err.provider.badKey',
  provider_forbidden: 'err.provider.forbidden',
  provider_rate_limit: 'err.provider.rateLimit',
  provider_no_model: 'err.provider.noModel',
  provider_failed: 'record.providerFailed',
  processing_timeout: 'recorder.processingTimeout',
  connection_lost: 'recorder.connectionLost',
}

export function promptPresetDisplayName(preset: Pick<PromptPreset, 'id' | 'name' | 'builtin'>): string {
  const key = preset.builtin ? BUILTIN_PRESET_NAME_KEYS[preset.id] : undefined
  return key ? t(key) : preset.name
}

export function recordedAppDisplayName(appId: string | undefined, fallback: string): string {
  const key = appId ? BUILTIN_APP_NAME_KEYS[appId] : undefined
  return key ? t(key) : fallback
}

export function recordedPromptPresetDisplayName(presetId: string | undefined, fallback: string): string {
  const key = presetId ? BUILTIN_PRESET_NAME_KEYS[presetId] : undefined
  return key ? t(key) : fallback
}

export function historyFailureReasonDisplay(record: {
  failReasonCode?: HistoryFailReasonCode
  failReason?: string
}): string {
  const key = record.failReasonCode ? HISTORY_FAILURE_KEYS[record.failReasonCode] : undefined
  return key ? t(key) : record.failReason || ''
}
