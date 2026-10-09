import * as bridge from '@/services/bridge'
import { ASR_PROVIDERS } from '@/features/settings/asrProviderCatalog'

const UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY = 'cloudAsr.unsupportedRuntimeBackup'
const ADDITIONAL_ASR_RUNTIME_BACKUPS_KEY = 'cloudAsr.unsupportedRuntimeAdditionalBackups'
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
    const fields = ['provider', 'model', 'apiKey', 'baseUrl', 'protocol',
      'systemInstruction', 'userPrompt', 'audioEncoding']
    const snapshot: Record<string, unknown> = {}
    for (const field of fields) snapshot[field] = await bridge.storeGet('cloudAsr.' + field)
    if (existingBackup === null || existingBackup === undefined) {
      await bridge.storeSet(UNSUPPORTED_ASR_RUNTIME_BACKUP_KEY, snapshot)
    } else {
      // Imports can replace the flat runtime fields while a previous backup
      // exists. Preserve both rather than clearing the newly imported key.
      const stored = await bridge.storeGet(ADDITIONAL_ASR_RUNTIME_BACKUPS_KEY)
      const additional = Array.isArray(stored) ? stored : []
      const identical = [existingBackup, ...additional].some((item) =>
        item !== null && typeof item === 'object' &&
        Object.entries(snapshot).every(([key, value]) => (item as Record<string, unknown>)[key] === value),
      )
      if (!identical) {
        await bridge.storeSet(ADDITIONAL_ASR_RUNTIME_BACKUPS_KEY, [...additional, snapshot])
      }
    }
    await bridge.storeSet('cloudAsr.provider', '')
    await bridge.storeSet('cloudAsr.apiKey', '')
  }

  const existingAiProvider = await bridge.storeGet('cloudAi.provider')
  if (existingAiProvider === null || existingAiProvider === undefined) {
    await bridge.storeSet('cloudAi.provider', 'openai_compat')
  }
}
