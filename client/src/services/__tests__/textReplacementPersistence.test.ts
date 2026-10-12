import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSetting, setSetting } from '../store'
import {
  applyTextReplacements,
  BUILTIN_REPLACEMENTS,
  getTextReplacements,
  saveTextReplacements,
  type TextReplacementRule,
} from '../textReplacement'

vi.mock('../store', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

let savedRules: TextReplacementRule[] | null

beforeEach(() => {
  savedRules = null
  vi.mocked(getSetting).mockImplementation(async () => savedRules)
  vi.mocked(setSetting).mockImplementation(async (_key, rules) => {
    savedRules = rules as TextReplacementRule[]
  })
})

describe('text replacement settings', () => {
  it('uses unambiguous defaults only when no value has been saved', async () => {
    expect(await getTextReplacements()).toEqual(BUILTIN_REPLACEMENTS)
    expect(BUILTIN_REPLACEMENTS.some((rule) => rule.from === 'pump')).toBe(false)
  })

  it('preserves an explicitly empty list across subsequent loads', async () => {
    await saveTextReplacements([])
    expect(await getTextReplacements()).toEqual([])
    expect(await applyTextReplacements('Git Hub pump')).toBe('Git Hub pump')
  })

  it('preserves saved and imported rules, including an old pump rule', async () => {
    const imported = [{ id: 'builtin_3', from: 'pump', to: 'Prompt', enabled: true }]
    savedRules = imported
    expect(await getTextReplacements()).toEqual(imported)
    expect(await applyTextReplacements('pump')).toBe('Prompt')
  })
})
