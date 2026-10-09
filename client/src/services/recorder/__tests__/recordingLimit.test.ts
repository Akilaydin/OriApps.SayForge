import { describe, it, expect } from 'vitest'
import {
  formatRecordingLimit,
  formatRecordingTimer,
  MAX_RECORDING_SEC,
  RECORDING_COUNTDOWN_SEC,
} from '../types'

describe('formatRecordingTimer', () => {
  it('shows elapsed time before the limit', () => {
    expect(formatRecordingTimer(0)).toMatchObject({ text: '0s', countdown: false })
    expect(formatRecordingTimer(12.7)).toMatchObject({ text: '12s', countdown: false })
    expect(formatRecordingTimer(239)).toMatchObject({ text: '239s', countdown: false })
  })

  it('counts down during the last minute', () => {
    expect(formatRecordingTimer(240)).toMatchObject({ text: '60s left', countdown: true, remainingSec: 60 })
    expect(formatRecordingTimer(253)).toMatchObject({ text: '47s left', countdown: true, remainingSec: 47 })
    expect(formatRecordingTimer(299)).toMatchObject({ text: '1s left', countdown: true, remainingSec: 1 })
  })

  it('clamps the limit and overtime to zero', () => {
    expect(formatRecordingTimer(300)).toMatchObject({ text: '0s left', remainingSec: 0 })
    expect(formatRecordingTimer(999)).toMatchObject({ text: '0s left', remainingSec: 0 })
  })

  it('handles invalid inputs', () => {
    expect(formatRecordingTimer(-5)).toMatchObject({ text: '0s', countdown: false })
    expect(formatRecordingTimer(Number.NaN)).toMatchObject({ text: '0s', countdown: false })
  })

  it('countdown window is shorter than the recording limit', () => {
    expect(RECORDING_COUNTDOWN_SEC).toBeGreaterThan(0)
    expect(RECORDING_COUNTDOWN_SEC).toBeLessThan(MAX_RECORDING_SEC)
  })

  it('recording limit matches native release timing', () => {
    // keyboard/mod.rs: const HARD_RELEASE_AFTER_SECS: u64 = 5 * 60
    expect(MAX_RECORDING_SEC).toBe(5 * 60)
  })
})

describe('formatRecordingLimit', () => {
  it('limit messages derive from the configured limit', () => {
    expect(formatRecordingLimit()).toBe(
      MAX_RECORDING_SEC < 60
        ? `${MAX_RECORDING_SEC}s`
        : MAX_RECORDING_SEC % 60 === 0
          ? `${MAX_RECORDING_SEC / 60} min`
          : `${Math.floor(MAX_RECORDING_SEC / 60)} min ${MAX_RECORDING_SEC % 60}s`,
    )
  })
})
