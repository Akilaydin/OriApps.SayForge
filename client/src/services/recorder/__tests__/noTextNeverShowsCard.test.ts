import { describe, expect, it } from 'vitest'

import SOURCE from '../RecorderOrchestrator.ts?raw'

const CARD_ENTRY_POINTS = ['showFailure(', 'failRunWithCard(']

const CARD_TITLE_KEYS = [
  'recorder.emptyAfterProcessingTitle',
  'recorder.protocolIncompleteTitle',
  'recorder.connectionLostTitle',
  'recorder.processingTimeoutTitle',
  'recorder.recognitionFailedTitle',
]

describe('empty recognition never creates a card', () => {
  it('loads real source before source assertions', () => {
    expect(SOURCE.length).toBeGreaterThan(1000)
    expect(SOURCE).toContain('showNoSpeech')
  })

  it('recognizes every card entry point', () => {
    for (const entry of CARD_ENTRY_POINTS) {
      expect(SOURCE, `Card entry ${entry} is missing; check for a rename`)
        .toContain(entry)
    }
  })

  it('does not reference the removed empty-result message', () => {
    expect(SOURCE).not.toContain("t('recorder.noResultTitle')")
    expect(SOURCE).not.toContain("t('recorder.noResultDetail')")
  })

  it('restricts card titles to the allowlist', () => {
    const titles: string[] = []
    for (const entry of CARD_ENTRY_POINTS) {
      let from = 0
      for (; ;) {
        const at = SOURCE.indexOf(entry, from)
        if (at < 0) break
        from = at + entry.length
        const window = SOURCE.slice(at, at + 400)
        const matched = /title:\s*t\('([^']+)'\)/.exec(window)
        if (matched) titles.push(matched[1])
      }
    }

    expect(titles.length).toBeGreaterThan(0)
    for (const title of titles) {
      expect(CARD_TITLE_KEYS, `Card title ${title} is not allowlisted`).toContain(title)
    }
  })

  it('both empty paths show no_text notifications', () => {
    const noSpeechCalls = SOURCE.match(/showNoSpeech\(/g) ?? []
    expect(noSpeechCalls.length).toBeGreaterThanOrEqual(3)
    const noTextBranches = SOURCE.match(/silenceProven \? 'silent' : 'no_text'/g) ?? []
    expect(noTextBranches.length).toBe(2)
  })
})
