/** English-only UI. Model recognition languages remain configurable separately. */
import * as bridge from '@/services/bridge'
import { getSetting, setSetting } from '@/services/store'
import { getLocale, setLocale, type LanguagePreference, type Locale } from '@/i18n'
import { ASR_PROVIDERS } from '@/features/settings/asrProviderCatalog'

const LANGUAGE_SETTING_KEY = 'ui.language'
const UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY = 'cloudAsr.unsupportedRuntimeBackup'
const SUPPORTED_ASR_RUNTIME_PROVIDERS = new Set([
  ...ASR_PROVIDERS.flatMap((entry) => entry.models.map((model) => model.provider)),
  'groq', 'groq_whisper', 'openai', 'openai_transcribe',
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
    'cloudAi.provider': 'openai_compat',
    'ai.builtinPromptLanguage': 'en',
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
