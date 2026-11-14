import { invoke } from './bridge'
import { addRuntimeEvent } from './debugLog'
import {
  DEFAULT_AI_CORRECTION_PROMPT,
  isAiCorrectionConfigured,
  loadAiCorrectionSettings,
} from './aiCorrectionSettings'

interface NativeCorrectionResult {
  text: string
  elapsed_ms: number
}

export interface AiCorrectionResult {
  text: string
  elapsedMs: number
  status: 'applied' | 'skipped' | 'unavailable' | 'failed'
}

// The native request has a 15-second HTTP timeout. The extra second also
// covers IPC delivery without letting a hung native call block insertion.
const CORRECTION_TIMEOUT_MS = 16_000

/** A failed optional correction never discards a valid ASR transcript. */
export async function correctTranscript(
  asrText: string,
  isCurrent: () => boolean = () => true,
): Promise<AiCorrectionResult | null> {
  const skipped: AiCorrectionResult = { text: asrText, elapsedMs: 0, status: 'skipped' }
  if (!asrText.trim()) return skipped

  let settings: Awaited<ReturnType<typeof loadAiCorrectionSettings>>
  try {
    settings = await loadAiCorrectionSettings()
  } catch {
    if (!isCurrent()) return null
    addRuntimeEvent('warn', 'ai_correction', 'Unable to read correction settings; using ASR text')
    return { ...skipped, status: 'unavailable' }
  }
  if (!isCurrent()) return null
  if (!settings.enabled) return skipped
  if (!isAiCorrectionConfigured(settings)) {
    addRuntimeEvent('warn', 'ai_correction', 'Correction enabled without a complete provider; using ASR text')
    return { ...skipped, status: 'unavailable' }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  try {
    const result = await Promise.race([
      invoke<NativeCorrectionResult>('cloud_polish', {
        request: {
          text: asrText,
          ai_config: {
            provider: 'openai_compat',
            api_url: settings.apiUrl,
            api_key: settings.apiKey,
            model: settings.model,
          },
          system_prompt: settings.prompt.trim() || DEFAULT_AI_CORRECTION_PROMPT,
        },
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('ai_correction_timeout')), CORRECTION_TIMEOUT_MS)
      }),
    ])
    if (!isCurrent()) return null
    if (typeof result.text !== 'string' || !result.text.trim()) {
      addRuntimeEvent('warn', 'ai_correction', 'Correction returned no text; using ASR text')
      return { text: asrText, elapsedMs: Date.now() - started, status: 'failed' }
    }
    addRuntimeEvent('info', 'ai_correction', 'Correction applied', {
      elapsedMs: result.elapsed_ms,
    })
    return { text: result.text, elapsedMs: result.elapsed_ms, status: 'applied' }
  } catch {
    if (!isCurrent()) return null
    // Do not log raw provider errors: they may contain request URLs, keys or text.
    addRuntimeEvent('warn', 'ai_correction', 'Correction request failed; using ASR text')
    return { text: asrText, elapsedMs: Date.now() - started, status: 'failed' }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
