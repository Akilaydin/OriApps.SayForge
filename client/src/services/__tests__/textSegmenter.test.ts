import { describe, expect, it } from 'vitest'
import { segmentAsrText } from '../textSegmenter'

describe('segmentAsrText', () => {
  it('leaves short text unchanged', () => {
    expect(segmentAsrText('Hello world')).toBe('Hello world')
    expect(segmentAsrText('')).toBe('')
  })

  it('splits a long passage at a topic change', () => {
    const text = 'We finished the first release and checked the test results. ' +
      'Additionally, the next milestone is performance and reliability.'
    expect(segmentAsrText(text).split('\n\n')).toHaveLength(2)
  })

  it('splits unusually long passages at sentence boundaries', () => {
    const text = 'A long dictation sentence containing repeated words '.repeat(6) +
      '. Here is the second sentence.'
    expect(segmentAsrText(text)).toContain('\n\n')
  })

  it('keeps decimal and version numbers intact', () => {
    const sentence = 'The new application version is 1.2.3 and the rate is 3.14.'
    expect(segmentAsrText(sentence)).toBe(sentence)
  })

  it('handles nullable input defensively', () => {
    expect(segmentAsrText(null as unknown as string)).toBeFalsy()
    expect(segmentAsrText(undefined as unknown as string)).toBeFalsy()
  })
})
