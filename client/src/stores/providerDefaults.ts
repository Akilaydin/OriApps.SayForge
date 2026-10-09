import * as bridge from '@/services/bridge'
import { ASR_PROVIDERS } from '@/features/settings/asrProviderCatalog'

const UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY = 'cloudAsr.unsupportedRuntimeBackup'
const SUPPORTED_ASR_RUNTIME_PROVIDERS = new Set([
  ...ASR_PROVIDERS.flatMap((entry) => entry.models.map((model) => model.provider)),
  'groq', 'groq_whisper', 'openai', 'openai_transcribe',
  'openai_compat_transcribe', 'openai_chat_audio', 'openai_chat_audio_standard',
])

/** Preserve user configuration when retiring a provider. */
export async function initProviderDefaults(): Promise<void> {
  const activeAsrProvider = await bridge.storeGet('cloudAsr.provider')
  if (typeof activeAsrProvider === 'string' && activeAsrProvider &&
    !SUPPORTED_ASR_RUNTIME_PROVIDERS.has(activeAsrProvider)) {
    const existingBackup = await bridge.storeGet(UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY)
    if (existingBackup === null || existingBackup === undefined) {
      const fields = ['provider', 'model', 'apiKey', 'appId', 'baseUrl', 'protocol',
        'systemInstruction', 'userPrompt', 'audioEncoding']
      const snapshot: Record<string, unknown> = {}
      for (const field of fields) snapshot[field] = await bridge.storeGet('cloudAsr.' + field)
      await bridge.storeSet(UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY, snapshot)
    }
    await bridge.storeSet('cloudAsr.provider', '')
    await bridge.storeSet('cloudAsr.apiKey', '')
  }

  const existingAiProvider = await bridge.storeGet('cloudAi.provider')
  if (existingAiProvider === null || existingAiProvider === undefined) {
    await bridge.storeSet('cloudAi.provider', 'openai_compat')
  }
}
