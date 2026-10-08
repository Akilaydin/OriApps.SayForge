import { describe, expect, it } from 'vitest'
import { applyReplacements, parseBatchReplacements, type TextReplacementRule } from '../textReplacement'

function rule(from: string, to: string, enabled = true): TextReplacementRule {
  return { id: '1', from, to, enabled }
}

describe('applyReplacements', () => {
  it('replaces matching text', () => {
    expect(applyReplacements('Hello world', [rule('Hello', 'Hi')])).toBe('Hi world')
  })
  it('replaces every occurrence', () => {
    expect(applyReplacements('um well um okay um', [rule('um ', '')])).toBe('well okay um')
  })
  it('does not apply disabled rules', () => {
    expect(applyReplacements('Hello world', [rule('Hello', 'Hi', false)])).toBe('Hello world')
  })
  it('does not match an empty source', () => {
    expect(applyReplacements('Hello', [rule('', 'Hi')])).toBe('Hello')
  })
  it('applies multiple replacements in sequence', () => {
    expect(applyReplacements('A', [rule('A', 'B'), rule('B', 'C')])).toBe('C')
  })
  it('keeps text with no rules', () => {
    expect(applyReplacements('Original', [])).toBe('Original')
  })
  it('accepts empty input', () => {
    expect(applyReplacements('', [rule('a', 'b')])).toBe('')
  })
})

describe('parseBatchReplacements', () => {
  it('parses comma-delimited pairs', () => {
    expect(parseBatchReplacements('Cloud Code,Claude Code')).toEqual([
      { from: 'Cloud Code', to: 'Claude Code' },
    ])
  })
  it('parses tab-delimited pairs from spreadsheets', () => {
    expect(parseBatchReplacements('Cloud Code\tClaude Code')).toEqual([
      { from: 'Cloud Code', to: 'Claude Code' },
    ])
  })
  it('accepts arrow separators', () => {
    expect(parseBatchReplacements('a => b\nc -> d')).toEqual([
      { from: 'a', to: 'b' },
      { from: 'c', to: 'd' },
    ])
  })
  it('trims whitespace and skips blank lines', () => {
    expect(parseBatchReplacements(' old , new \n\nstart,finish\n')).toEqual([
      { from: 'old', to: 'new' },
      { from: 'start', to: 'finish' },
    ])
  })
  it('treats a line with no separator as a deletion rule', () => {
    expect(parseBatchReplacements('filler')).toEqual([{ from: 'filler', to: '' }])
  })
  it('uses the first separator and preserves later commas', () => {
    expect(parseBatchReplacements('abc,a, b')).toEqual([{ from: 'abc', to: 'a, b' }])
  })
  it('ignores lines without a source', () => {
    expect(parseBatchReplacements(',replacement')).toEqual([])
  })
})

describe('replacement precedence', () => {
  const namedRule = (id: string, from: string, to: string) => ({ id, from, to, enabled: true })

  it('allows cascading replacements in the declared order', () => {
    expect(applyReplacements('A', [
      namedRule('a', 'A', 'B'), namedRule('b', 'B', 'C'),
    ])).toBe('C')
    expect(applyReplacements('A', [
      namedRule('b', 'B', 'C'), namedRule('a', 'A', 'B'),
    ])).toBe('B')
  })
  it('applies the earlier matching rule before later rules', () => {
    expect(applyReplacements('Hello world', [
      namedRule('a', 'Hello world', 'Greetings'),
      namedRule('b', 'Hello', 'Hi'),
    ])).toBe('Greetings')
    expect(applyReplacements('Hello world', [
      namedRule('b', 'Hello', 'Hi'),
      namedRule('a', 'Hello world', 'Greetings'),
    ])).toBe('Hi world')
  })
  it('skips disabled rules without changing the order of other rules', () => {
    expect(applyReplacements('A', [
      { ...namedRule('a', 'A', 'B'), enabled: false },
      namedRule('b', 'A', 'C'),
    ])).toBe('C')
  })
})
