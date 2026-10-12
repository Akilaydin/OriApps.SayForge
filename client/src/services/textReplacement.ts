
import { getSetting, setSetting } from './store'

export interface TextReplacementRule {
  id: string
  from: string
  to: string
  enabled: boolean
}

const STORAGE_KEY = 'textReplacements'

export const BUILTIN_REPLACEMENTS: TextReplacementRule[] = [
  { id: 'builtin_1', from: 'Chat G P T', to: 'ChatGPT', enabled: true },
  { id: 'builtin_2', from: 'Git Hub', to: 'GitHub', enabled: true },
  { id: 'builtin_4', from: 'Cloud Code', to: 'Claude Code', enabled: true },
]

export async function getTextReplacements(): Promise<TextReplacementRule[]> {
  const rules = await getSetting<TextReplacementRule[] | null>(STORAGE_KEY, null)
  if (rules == null) {
    return BUILTIN_REPLACEMENTS.map((r) => ({ ...r }))
  }
  return rules
}

export async function saveTextReplacements(rules: TextReplacementRule[]): Promise<void> {
  await setSetting(STORAGE_KEY, rules)
}

export interface ParsedReplacement {
  from: string
  to: string
}

export function parseBatchReplacements(input: string): ParsedReplacement[] {
  const separators = ['\t', '=>', '->', ',']
  const result: ParsedReplacement[] = []

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    let sepIndex = -1
    let sepLen = 0
    for (const sep of separators) {
      const i = line.indexOf(sep)
      if (i >= 0 && (sepIndex === -1 || i < sepIndex)) {
        sepIndex = i
        sepLen = sep.length
      }
    }

    let from = line
    let to = ''
    if (sepIndex >= 0) {
      from = line.slice(0, sepIndex).trim()
      to = line.slice(sepIndex + sepLen).trim()
    }

    if (!from) continue
    result.push({ from, to })
  }

  return result
}

export function applyReplacements(text: string, rules: TextReplacementRule[]): string {
  let result = text
  for (const rule of rules) {
    if (rule.enabled && rule.from) {
      result = result.split(rule.from).join(rule.to)
    }
  }
  return result
}

export async function applyTextReplacements(text: string): Promise<string> {
  if (!text) return text
  const rules = await getTextReplacements()
  if (rules.length === 0) return text
  return applyReplacements(text, rules)
}
