import { getSetting, setSetting } from './store'

export interface AiCorrectionSettings {
  enabled: boolean
  apiUrl: string
  apiKey: string
  model: string
  prompt: string
}

export const DEFAULT_AI_CORRECTION_PROMPT =
  'Clean up the speech transcript. Fix recognition errors, punctuation and capitalization. Preserve the meaning and language. Return only the corrected text.'

export async function loadAiCorrectionSettings(): Promise<AiCorrectionSettings> {
  const [enabled, apiUrl, apiKey, model, prompt] = await Promise.all([
    getSetting('aiEnabled', false),
    getSetting('cloudAi.apiUrl', ''),
    getSetting('cloudAi.apiKey', ''),
    getSetting('cloudAi.model', ''),
    getSetting('cloudAi.systemPrompt', DEFAULT_AI_CORRECTION_PROMPT),
  ])

  return { enabled, apiUrl, apiKey, model, prompt }
}

export async function saveAiCorrectionSettings(settings: AiCorrectionSettings): Promise<void> {
  await Promise.all([
    setSetting('cloudAi.provider', 'openai_compat'),
    setSetting('cloudAi.apiUrl', settings.apiUrl),
    setSetting('cloudAi.apiKey', settings.apiKey),
    setSetting('cloudAi.model', settings.model),
    setSetting('cloudAi.systemPrompt', settings.prompt),
  ])
  await setSetting('aiEnabled', settings.enabled)
}

export function isAiCorrectionConfigured(settings: AiCorrectionSettings): boolean {
  if (!settings.apiKey.trim() || !settings.model.trim()) return false
  try {
    const url = new URL(settings.apiUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}
