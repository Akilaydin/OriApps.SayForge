import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIC_GAIN_DB,
  DEFAULT_MIC_GAIN_ENABLED,
  MAX_MIC_GAIN_DB,
  MIN_MIC_GAIN_DB,
  microphoneGainMultiplier,
  normalizeMicGainDb,
} from '../micGain'
import { getDefault } from '../defaults'

describe('microphone boost settings', () => {
  it('preserves the existing enabled +6 dB behavior for missing settings', () => {
    expect(DEFAULT_MIC_GAIN_ENABLED).toBe(true)
    expect(DEFAULT_MIC_GAIN_DB).toBe(6)
    expect(getDefault('micGainEnabled')).toBe(true)
    expect(getDefault('micGainDb')).toBe(6)
    expect(microphoneGainMultiplier({ enabled: true, db: 6 })).toBeCloseTo(2, 2)
  })

  it('disabling boost is exactly unity gain at any saved slider value', () => {
    expect(microphoneGainMultiplier({ enabled: false, db: 0 })).toBe(1)
    expect(microphoneGainMultiplier({ enabled: false, db: 18 })).toBe(1)
  })

  it('0 dB is unity gain even when boost is enabled', () => {
    expect(microphoneGainMultiplier({ enabled: true, db: 0 })).toBe(1)
  })

  it('normalizes invalid, fractional and out-of-range stored values', () => {
    for (const value of [undefined, null, '12', NaN, Infinity, -Infinity, {}]) {
      expect(normalizeMicGainDb(value)).toBe(DEFAULT_MIC_GAIN_DB)
    }
    expect(normalizeMicGainDb(-2)).toBe(MIN_MIC_GAIN_DB)
    expect(normalizeMicGainDb(99)).toBe(MAX_MIC_GAIN_DB)
    expect(normalizeMicGainDb(7.7)).toBe(8)
    expect(normalizeMicGainDb(7.2)).toBe(7)
  })

  it('converts slider dB to amplitude without unbounded gain', () => {
    expect(microphoneGainMultiplier({ enabled: true, db: 12 })).toBeCloseTo(3.9811, 3)
    expect(microphoneGainMultiplier({ enabled: true, db: -100 })).toBe(1)
    expect(microphoneGainMultiplier({ enabled: true, db: 100 })).toBeCloseTo(7.9433, 3)
    expect(microphoneGainMultiplier({ enabled: true, db: NaN })).toBeCloseTo(2, 2)
  })
})
