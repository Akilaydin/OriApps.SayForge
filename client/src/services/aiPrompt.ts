import { getSetting, setSetting } from './store'

export const AI_PROMPT_KEY = 'cloudAi.systemPrompt'
export const DEFAULT_AI_PROMPT = 'Clean up the speech transcript. Fix recognition errors, punctuation and capitalization. Preserve the meaning and language. Return only the corrected text.'

/** Adopt the selected custom preset once; built-in presets use the current default. */
export async function getAiPrompt(): Promise<string> {
  const saved = await getSetting<unknown>(AI_PROMPT_KEY, null)
  if (typeof saved === 'string') return saved
  const [raw, activeId, append] = await Promise.all([
    getSetting<unknown>('promptPresets', []), getSetting('activePresetId', 'intent'),
    getSetting<unknown>('aiPromptAppend', ''),
  ])
  const preset = Array.isArray(raw) ? raw.find((p) =>
    p && p.id === activeId && p.builtin !== true && typeof p.systemPrompt === 'string',
  ) : undefined
  const prompt = [preset?.systemPrompt ?? DEFAULT_AI_PROMPT, typeof append === 'string' ? append : ''].filter(Boolean).join('\n\n')
  await setSetting(AI_PROMPT_KEY, prompt)
  return prompt
}

export function buildHotwordInjectionPart(hotwords: string[] | undefined): string | null {
  if (!hotwords || hotwords.length === 0) return null
  const terms = Array.from(new Set(hotwords.map((w) => w.trim()).filter(Boolean)))
  if (terms.length === 0) return null
  return `User's technical vocabulary: Prefer the following spellings and capitalization when speech recognition is ambiguous, and preserve them exactly:\n${terms.join(', ')}`
}

