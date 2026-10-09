import { describe, expect, it } from 'vitest'
import {
  restoreHotwordSpacing,
  stripTrailingPunctuation,
  replacePunctuationWithSpace,
  DEFAULT_POST_PROCESS,
} from '../textPostProcess'

describe('restoreHotwordSpacing', () => {
  it('restores spaces added in technical identifiers', () => {
    expect(restoreHotwordSpacing('I use Say Forge daily', ['SayForge'])).toBe('I use SayForge daily')
    expect(restoreHotwordSpacing('Type less is useful', ['Typeless'])).toBe('Typeless is useful')
  })
  it('corrects the capitalization of recognized terms', () => {
    expect(restoreHotwordSpacing('Say forge', ['SayForge'])).toBe('SayForge')
    expect(restoreHotwordSpacing('I use typeless', ['Typeless'])).toBe('I use Typeless')
  })
  it('preserves ordinary phrases and word boundaries', () => {
    expect(restoreHotwordSpacing('I say it loudly', ['SayForge'])).toBe('I say it loudly')
    expect(restoreHotwordSpacing('Say Item here', ['SayForge'])).toBe('Say Item here')
  })
  it('handles empty strings and nonexistent hotwords', () => {
    expect(restoreHotwordSpacing('Say It', [])).toBe('Say It')
    expect(restoreHotwordSpacing('', ['SayForge'])).toBe('')
  })
  it('ignores hotwords containing spaces or punctuation', () => {
    expect(restoreHotwordSpacing('a b', ['a b'])).toBe('a b')
    expect(restoreHotwordSpacing('C#', ['C#'])).toBe('C#')
  })
})

describe('stripTrailingPunctuation', () => {
  it('removes sentence-ending punctuation, preserving interior punctuation', () => {
    expect(stripTrailingPunctuation('Hello, world!')).toBe('Hello, world')
    expect(stripTrailingPunctuation('Really?!')).toBe('Really')
    expect(stripTrailingPunctuation('This looks good...')).toBe('This looks good')
  })
  it('processes each line independently', () => {
    expect(stripTrailingPunctuation('First line.\nSecond line!')).toBe('First line\nSecond line')
  })
  it('handles empty text', () => {
    expect(stripTrailingPunctuation('')).toBe('')
  })
})

describe('replacePunctuationWithSpace', () => {
  it('replaces punctuation and collapses adjacent spaces', () => {
    expect(replacePunctuationWithSpace('Hello, world!')).toBe('Hello world')
    expect(replacePunctuationWithSpace('One; two, three')).toBe('One two three')
  })
  it('retains decimals and percentage values', () => {
    expect(replacePunctuationWithSpace('The value is 3.14, approximately')).toBe('The value is 3.14 approximately')
    expect(replacePunctuationWithSpace('Growth was 15%, excellent')).toBe('Growth was 15% excellent')
  })
  it('preserves line boundaries', () => {
    expect(replacePunctuationWithSpace('Line one.\nLine two.')).toBe('Line one\nLine two')
  })
  it('keeps safe defaults language-independent', () => {
    expect(DEFAULT_POST_PROCESS).toEqual({
      autoSegment: true,
      stripTrailingPunctuation: false,
      punctuationToSpace: false,
    })
  })
})
