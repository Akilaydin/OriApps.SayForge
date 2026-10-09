import type { HistoryFailReasonCode, PromptPreset } from '@/services/store'
import type { AppPromptRule } from '@/services/personalization/types'
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

const LOCAL_MODEL_KEYS: Record<string, {
  name: TranslationKey
  description: TranslationKey
  languages: TranslationKey
}> = {
  'parakeet-unified-en-0.6b-gguf': {
    name: 'localModel.parakeetEn.name',
    description: 'localModel.parakeetEn.description',
    languages: 'localModel.parakeetEn.languages',
  },
  'nemotron-asr-streaming-0.6b-gguf': {
    name: 'localModel.nemotron.name',
    description: 'localModel.nemotron.description',
    languages: 'localModel.nemotron.languages',
  },
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

export function appPromptRuleDisplayName(rule: Pick<AppPromptRule, 'id' | 'appId' | 'name' | 'builtin'>): string {
  const key = rule.builtin ? BUILTIN_APP_NAME_KEYS[rule.appId || rule.id] : undefined
  return key ? t(key) : rule.name
}

export function recordedAppDisplayName(appId: string | undefined, fallback: string): string {
  const key = appId ? BUILTIN_APP_NAME_KEYS[appId] : undefined
  return key ? t(key) : fallback
}

export function recordedPromptPresetDisplayName(presetId: string | undefined, fallback: string): string {
  const key = presetId ? BUILTIN_PRESET_NAME_KEYS[presetId] : undefined
  return key ? t(key) : fallback
}

interface LocalModelDisplaySource {
  id: string
  name: string
  description?: string
  languages_label?: string
}

export function localModelDisplayName(model: LocalModelDisplaySource): string {
  const key = LOCAL_MODEL_KEYS[model.id]?.name
  return key ? t(key) : model.name
}

export function localModelDisplayDescription(model: LocalModelDisplaySource): string {
  const key = LOCAL_MODEL_KEYS[model.id]?.description
  return key ? t(key) : model.description || ''
}

export function localModelDisplayLanguages(model: LocalModelDisplaySource): string {
  const key = LOCAL_MODEL_KEYS[model.id]?.languages
  return key ? t(key) : model.languages_label || ''
}

export function historyFailureReasonDisplay(record: {
  failReasonCode?: HistoryFailReasonCode
  failReason?: string
}): string {
  const key = record.failReasonCode ? HISTORY_FAILURE_KEYS[record.failReasonCode] : undefined
  return key ? t(key) : record.failReason || ''
}
