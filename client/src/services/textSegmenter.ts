/** Split long transcripts into paragraphs at sentence and topic boundaries. */
const TOPIC_SHIFTS = [
  'first', 'second', 'third', 'firstly', 'secondly',
  'another point', 'additionally', 'furthermore', 'moreover',
  'on the other hand', 'next', 'finally', 'in conclusion',
  'also', 'in addition', 'by the way',
]

const SENTENCE_END_RE = /[.!?]/

function startsWithTopicShift(text: string): boolean {
  const rest = text.trimStart().toLowerCase()
  return TOPIC_SHIFTS.some((phrase) =>
    rest.startsWith(phrase + ' ') || rest.startsWith(phrase + ',') ||
    rest.startsWith(phrase + ':'),
  )
}

export function segmentAsrText(text: string): string {
  if (!text || text.length < 40) return text

  const segments: string[] = []
  let currentStart = 0
  for (let i = 0; i < text.length; i += 1) {
    if (!SENTENCE_END_RE.test(text[i])) continue
    // Ignore the periods separating digits in versions or decimal numbers.
    if (text[i] === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) continue
    const afterPunc = i + 1
    if (afterPunc >= text.length) continue
    const currentLen = afterPunc - currentStart
    const rest = text.slice(afterPunc)

    if ((currentLen >= 20 && startsWithTopicShift(rest)) || currentLen >= 250) {
      segments.push(text.slice(currentStart, afterPunc))
      currentStart = afterPunc
    }
  }
  if (currentStart < text.length) segments.push(text.slice(currentStart))
  return segments.join('\n\n')
}
