/** English-only UI. Model recognition languages remain configurable separately. */
import * as bridge from '@/services/bridge'
import { getSetting, setSetting } from '@/services/store'
import { getLocale, setLocale, type LanguagePreference, type Locale } from '@/i18n'
import { ASR_PROVIDERS } from '@/features/settings/asrProviderCatalog'

const LANGUAGE_SETTING_KEY = 'ui.language'
const UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY = 'cloudAsr.unsupportedRuntimeBackup'
const SUPPORTED_ASR_RUNTIME_PROVIDERS = new Set([
  ...ASR_PROVIDERS.flatMap((entry) => entry.models.map((model) => model.provider)),
  'openai_compat_transcribe', 'openai_chat_audio', 'openai_chat_audio_standard',
])

export async function initLanguage(): Promise<Locale> {
  setLocale('en')
  const saved = await getSetting(LANGUAGE_SETTING_KEY, 'en').catch(() => 'en')
  if (saved !== 'en') await setSetting(LANGUAGE_SETTING_KEY, 'en').catch(() => {})
  return 'en'
}

/** Preserve user-configured values but use international defaults on fresh installs. */
export async function initLocaleDefaults(_locale: Locale): Promise<void> {
  const defaults: Record<string, string> = {
    'localAsr.downloadSource': 'HuggingFace',
    'cloudAi.provider': 'openai_compat',
    'ai.builtinPromptLanguage': 'en',
    'localAsr.modelId': 'nemotron-asr-streaming-0.6b-gguf',
  }
  // This distribution no longer offers the old Chinese-origin GGUF models.
  // Keep their files intact but migrate the selected model to multilingual Nemotron.
  const selectedModel = await bridge.storeGet('localAsr.modelId')
  if (typeof selectedModel === 'string' && ['sensevoice-small-gguf',
    'funasr-nano-2512-gguf', 'qwen3-asr-0.6b-gguf',
    'qwen3-asr-1.7b-q4-gguf', 'qwen3-asr-1.7b-gguf',
  ].includes(selectedModel)) {
    await bridge.storeSet('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf')
  }

  // A previously selected vendor may no longer exist. Back up the whole
  // runtime configuration before disarming that route; persisted profiles
  // and provider-specific credential settings remain untouched.
  const activeAsrProvider = await bridge.storeGet('cloudAsr.provider')
  if (typeof activeAsrProvider === 'string' && activeAsrProvider &&
    !SUPPORTED_ASR_RUNTIME_PROVIDERS.has(activeAsrProvider)) {
    const existingBackup = await bridge.storeGet(UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY)
    if (existingBackup === null || existingBackup === undefined) {
      const fields = ['provider', 'model', 'apiKey', 'appId', 'baseUrl', 'protocol',
        'systemInstruction', 'userPrompt', 'audioEncoding', 'qwen.workspaceId',
        'omniSystemPrompt']
      const snapshot: Record<string, unknown> = {}
      for (const field of fields) snapshot[field] = await bridge.storeGet('cloudAsr.' + field)
      await bridge.storeSet(UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY, snapshot)
    }
    await bridge.storeSet('cloudAsr.provider', '')
    await bridge.storeSet('cloudAsr.apiKey', '')
  }

  await Promise.all(Object.entries(defaults).map(async ([key, value]) => {
    const existing = await bridge.storeGet(key)
    if (existing === null || existing === undefined) await bridge.storeSet(key, value)
  }))
}

export async function switchLanguage(_preference: LanguagePreference): Promise<Locale> {
  setLocale('en')
  await setSetting(LANGUAGE_SETTING_KEY, 'en')
  return 'en'
}

export async function getLanguagePreference(): Promise<LanguagePreference> {
  return 'en'
}

export function getActiveLanguage(): Locale {
  return getLocale()
}
