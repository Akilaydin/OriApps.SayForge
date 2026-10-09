import diff from 'fast-diff'

export type AsrDiffKind = 'equal' | 'delete' | 'insert'

export interface AsrDiffSegment {
  kind: AsrDiffKind
  text: string
}

export function normalizeForDiff(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

export function computeAsrDiff(original: string, corrected: string): AsrDiffSegment[] {
  const a = normalizeForDiff(original)
  const b = normalizeForDiff(corrected)
  if (a === b) return a ? [{ kind: 'equal', text: a }] : []

  return diff(a, b, undefined, true)
    .filter(([, text]) => text.length > 0)
    .map(([op, text]): AsrDiffSegment => ({
      kind: op === diff.INSERT ? 'insert' : op === diff.DELETE ? 'delete' : 'equal',
      text,
    }))
}

export function countAsrDiffChanges(segments: AsrDiffSegment[]): number {
  let count = 0
  let inChange = false
  for (const segment of segments) {
    if (segment.kind === 'equal') {
      inChange = false
      continue
    }
    if (!inChange) {
      count += 1
      inChange = true
    }
  }
  return count
}

export function hasAsrDiffChange(segments: AsrDiffSegment[]): boolean {
  return segments.some((segment) => segment.kind !== 'equal')
}
