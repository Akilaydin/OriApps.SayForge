import { describe, it, expect } from 'vitest'
import { clampSec, elapsedSecFromPerf, normalizeDurations, pickVoiceDurationSec } from '../timeModel'

describe('clampSec', () => {
  it('preserves positive values', () => {
    expect(clampSec(5.5)).toBe(5.5)
  })

  it('normalizes negatives to zero', () => {
    expect(clampSec(-1)).toBe(0)
  })

  it('normalizes NaN to zero', () => {
    expect(clampSec(NaN)).toBe(0)
  })

  it('normalizes Infinity to zero', () => {
    expect(clampSec(Infinity)).toBe(0)
  })
})

describe('elapsedSecFromPerf', () => {
  it('calculates elapsed time', () => {
    const result = elapsedSecFromPerf(1000, 2500)
    expect(result).toBeCloseTo(1.5)
  })

  it('zero startPerf returns zero', () => {
    expect(elapsedSecFromPerf(0)).toBe(0)
  })

  it('negative startPerf returns zero', () => {
    expect(elapsedSecFromPerf(-100)).toBe(0)
  })

  it('NaN startPerf returns zero', () => {
    expect(elapsedSecFromPerf(NaN)).toBe(0)
  })
})

describe('normalizeDurations', () => {
  it('preserves valid durations', () => {
    const result = normalizeDurations({ holdSec: 5, audioSec: 4.8, asrSec: 4.5 })
    expect(result.holdSec).toBe(5)
    expect(result.audioSec).toBe(4.8)
    expect(result.asrSec).toBe(4.5)
  })

  it('normalizes nonpositive durations', () => {
    const result = normalizeDurations({ holdSec: -1, audioSec: 0, asrSec: -5 })
    expect(result.holdSec).toBe(0)
    expect(result.audioSec).toBeUndefined()
    expect(result.asrSec).toBeUndefined()
  })
})

describe('pickVoiceDurationSec', () => {
  it('prefers holdSec', () => {
    expect(pickVoiceDurationSec({ holdSec: 5, audioSec: 4, asrSec: 3 })).toBe(5)
  })

  it('falls back to asrSec when holdSec is zero', () => {
    expect(pickVoiceDurationSec({ holdSec: 0, audioSec: 4, asrSec: 3 })).toBe(3)
  })

  it('falls back to audioSec when holdSec and asrSec are zero', () => {
    expect(pickVoiceDurationSec({ holdSec: 0, audioSec: 4 })).toBe(4)
  })

  it('returns zero when every duration is zero', () => {
    expect(pickVoiceDurationSec({ holdSec: 0 })).toBe(0)
  })
})
