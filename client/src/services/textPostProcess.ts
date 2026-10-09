/** Language-independent transcription post-processing. */
import { getSetting, setSetting } from './store'
import { applyTextReplacements } from './textReplacement'
import { segmentAsrText } from './textSegmenter'

/** Restore technical terms if an ASR engine added spaces inside them. */
export function restoreHotwordSpacing(text: string, hotwords: string[]): string {
  if (!text || !hotwords || hotwords.length === 0) return text
  const targets = hotwords
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && /^[A-Za-z0-9]+$/.test(w) && /[A-Za-z]/.test(w))
  if (targets.length === 0) return text
  targets.sort((a, b) => b.length - a.length)
  let result = text
  for (const hw of targets) {
    const inner = hw.split('').join('\\s*')
    const re = new RegExp(`\\b${inner}\\b`, 'gi')
    result = result.replace(re, (match) => {
      if (match === hw) return match
      if (/\s/.test(match) && match[0] !== hw[0]) return match
      return hw
    })
  }
  return result
}

/** Remove sentence-ending punctuation from each line, preserving internal punctuation. */
export function stripTrailingPunctuation(text: string): string {
  if (!text) return text
  return text
    .split('\n')
    .map((line) => line.replace(/[.!?,;:'"\s]+$/u, ''))
    .join('\n')
}

/** Replace punctuation with spaces while preserving decimal points and percentages. */
export function replacePunctuationWithSpace(text: string): string {
  if (!text) return text
  let result = text.replace(
    /(?<!\d)\.(?!\d)|[!?,;:"'(){}<>_=+|@#^&*~—–\[\]]/gu,
    ' ',
  )
  result = result.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim()
  return result
}

export interface TextPostProcessOptions {
  autoSegment: boolean
  stripTrailingPunctuation: boolean
  punctuationToSpace: boolean
}

export const APPLIES_WITH_AI: Record<keyof TextPostProcessOptions, boolean> = {
  autoSegment: false,
  stripTrailingPunctuation: false,
  punctuationToSpace: false,
}

const STORAGE_KEY = 'textPostProcess'

export const DEFAULT_POST_PROCESS: TextPostProcessOptions = {
  autoSegment: true,
  stripTrailingPunctuation: false,
  punctuationToSpace: false,
}

/** Read current formatting options with safe defaults. */
export async function getTextPostProcessOptions(): Promise<TextPostProcessOptions> {
  const saved = await getSetting<Partial<TextPostProcessOptions>>(STORAGE_KEY, {})
  return {
    autoSegment: typeof saved?.autoSegment === 'boolean' ? saved.autoSegment : DEFAULT_POST_PROCESS.autoSegment,
    stripTrailingPunctuation: saved?.stripTrailingPunctuation === true,
    punctuationToSpace: saved?.punctuationToSpace === true,
  }
}

export async function saveTextPostProcessOptions(opts: TextPostProcessOptions): Promise<void> {
  await setSetting(STORAGE_KEY, opts)
}

export interface ApplyTransformsOptions {
  rawAsr?: boolean
}

export async function applyTextTransforms(
  text: string,
  options: ApplyTransformsOptions = {},
): Promise<string> {
  if (!text) return text
  const opts = await getTextPostProcessOptions()
  const ownFormat = options.rawAsr ?? true
  const active = (key: keyof TextPostProcessOptions) =>
    opts[key] && (ownFormat || APPLIES_WITH_AI[key])
  let result = text
  if (active('autoSegment')) result = segmentAsrText(result)
  result = await applyTextReplacements(result)
  if (active('stripTrailingPunctuation')) result = stripTrailingPunctuation(result)
  if (active('punctuationToSpace')) result = replacePunctuationWithSpace(result)
  return result
}
