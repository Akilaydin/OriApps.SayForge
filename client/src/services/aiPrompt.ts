import { getSetting, setSetting } from './store'

export const AI_PROMPT_KEY = 'cloudAi.systemPrompt'
export const DEFAULT_AI_PROMPT = 'Clean up the speech transcript. Fix recognition errors, punctuation and capitalization. Preserve the meaning and language. Return only the corrected text.'

/** Adopt a user-edited legacy preset once, without altering the original records. */
export async function getAiPrompt(): Promise<string> {
  const saved = await getSetting<unknown>(AI_PROMPT_KEY, null)
  if (typeof saved === 'string') return saved
  const [raw, activeId, append] = await Promise.all([
    getSetting<unknown>('promptPresets', []), getSetting('activePresetId', 'intent'),
    getSetting<unknown>('aiPromptAppend', ''),
  ])
  const preset = Array.isArray(raw) ? raw.find((p) => p && p.id === activeId && typeof p.systemPrompt === 'string') : undefined
  // An explicitly unmodified bundled preset belongs to a retired locale, not
  // to the user. Preserve every other preset, including edits in any language.
  const base = preset?.builtin === true && preset?.builtinPromptModified === false
    ? DEFAULT_AI_PROMPT : preset?.systemPrompt ?? DEFAULT_AI_PROMPT
  const prompt = [base, typeof append === 'string' ? append : ''].filter(Boolean).join('\n\n')
  await setSetting(AI_PROMPT_KEY, prompt)
  return prompt
}

export function buildHotwordInjectionPart(hotwords: string[] | undefined): string | null {
  if (!hotwords || hotwords.length === 0) return null
  const terms = Array.from(new Set(hotwords.map((w) => w.trim()).filter(Boolean)))
  if (terms.length === 0) return null
  return `User's technical vocabulary: Prefer the following spellings and capitalization when speech recognition is ambiguous, and preserve them exactly:\n${terms.join(', ')}`
}

