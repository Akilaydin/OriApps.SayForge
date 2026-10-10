import { describe, it, expect } from 'vitest'
import {
  summarizeAppContext,
  buildStatsAppId,
  isModifierPTTSetting,
  computeProcessingTimeoutMs,
  classifyMicLevel,
  judgeOsMicMute,
  hasSilenceEvidence,
  isUnconfirmedPaste,
  MIC_NO_SIGNAL_PEAK_THRESHOLD,
  MIC_LOW_RMS_THRESHOLD,
  OS_MIC_MUTE_CONFIRM_SAMPLES,
} from '../helpers'

describe('hasSilenceEvidence', () => {
  const SILENCE_RMS_THRESHOLD = 0.01

  function stats(peakAmplitude: number, silentFrames: number, totalFrames: number) {
    return { peakAmplitude, silentFrames, totalFrames, silenceRmsThreshold: SILENCE_RMS_THRESHOLD }
  }

  it('speech followed by silence is not silent audio', () => {
    expect(hasSilenceEvidence(stats(0.4, 996, 1000))).toBe(false)
  })

  it('requires both silent frames and a near-zero peak', () => {
    expect(hasSilenceEvidence(stats(0.004, 999, 1000))).toBe(true)
  })

  it('low peak alone does not establish silence', () => {
    expect(hasSilenceEvidence(stats(0.004, 900, 1000))).toBe(false)
  })

  it('missing frame evidence does not establish silence', () => {
    expect(hasSilenceEvidence(stats(0, 0, 0))).toBe(false)
  })

  it('silence threshold is strictly exclusive', () => {
    expect(hasSilenceEvidence(stats(SILENCE_RMS_THRESHOLD, 1000, 1000))).toBe(false)
  })
})

describe('judgeOsMicMute', () => {
  it('audio flow clears the system mute flag', () => {
    expect(judgeOsMicMute(0, 'voiced', 1600)).toEqual({ verdict: 'dismissed' })
    expect(judgeOsMicMute(0, 'low', 1600)).toEqual({ verdict: 'dismissed' })
  })

  it('one nonzero signal invalidates pending mute evidence', () => {
    expect(judgeOsMicMute(OS_MIC_MUTE_CONFIRM_SAMPLES - 1, 'low', 1600))
      .toEqual({ verdict: 'dismissed' })
  })

  it('accumulates zero samples below the confirmation threshold', () => {
    expect(judgeOsMicMute(0, 'muted', 1600)).toEqual({ verdict: 'wait', silentSamples: 1600 })
    expect(judgeOsMicMute(1600, 'muted', 1600)).toEqual({ verdict: 'wait', silentSamples: 3200 })
  })

  it('confirms mute only after enough zero samples', () => {
    expect(judgeOsMicMute(OS_MIC_MUTE_CONFIRM_SAMPLES - 1600, 'muted', 1600))
      .toEqual({ verdict: 'confirmed' })
  })
})

describe('classifyMicLevel', () => {
  it('only a strictly zero peak is muted', () => {
    expect(classifyMicLevel(0, 0)).toBe('muted')
    expect(classifyMicLevel(0.05, MIC_NO_SIGNAL_PEAK_THRESHOLD)).toBe('muted')
  })

  it('classifies any nonzero weak input as low', () => {
    expect(classifyMicLevel(Number.MIN_VALUE, Number.MIN_VALUE)).toBe('low')
    expect(classifyMicLevel(0.004, 0.05)).toBe('low')
    expect(classifyMicLevel(MIC_LOW_RMS_THRESHOLD - 0.0001, 1 / 32768)).toBe('low')
  })

  it('classifies normal RMS as voiced', () => {
    expect(classifyMicLevel(0.03, 0.2)).toBe('voiced')
    expect(classifyMicLevel(MIC_LOW_RMS_THRESHOLD, 0.1)).toBe('voiced')
  })
})

describe('summarizeAppContext', () => {
  it('returns null for null metadata', () => {
    expect(summarizeAppContext(null)).toBeNull()
  })

  it('extracts target metadata', () => {
    const result = summarizeAppContext({
      processName: 'code.exe',
      exePath: 'C:\\Program Files\\Code\\code.exe',
      windowTitle: 'secret-doc.md',
      windowClass: 'Chrome_WidgetWin_1',
      focusClass: 'Chrome_RenderWidgetHostHWND',
      controlType: 'Edit',
    })
    expect(result?.processName).toBe('code.exe')
    expect(result?.windowTitle).toBe('secret-doc.md')
  })
})

describe('buildStatsAppId', () => {
  it('prefers processName', () => {
    expect(buildStatsAppId({ processName: 'code.exe' } as any)).toBe('code.exe')
  })

  it('falls back to the executable basename', () => {
    expect(buildStatsAppId({ exePath: 'C:\\Apps\\notepad.exe' } as any)).toBe('notepad.exe')
  })

  it('falls back to promptAppId', () => {
    expect(buildStatsAppId(null, 'my-app')).toBe('my-app')
  })

  it('uses unknown without identity fields', () => {
    expect(buildStatsAppId(null)).toBe('unknown')
  })
})

describe('isModifierPTTSetting', () => {
  it('recognizes modifiers in single keys and combinations', () => {
    expect(isModifierPTTSetting('AltLeft')).toBe(true)
    expect(isModifierPTTSetting('ControlRight')).toBe(true)
    expect(isModifierPTTSetting('ShiftLeft')).toBe(true)
    expect(isModifierPTTSetting('ControlLeft+KeyK')).toBe(true)
    expect(isModifierPTTSetting('ControlLeft+MetaLeft')).toBe(true)
  })

  it('rejects non-modifier keys', () => {
    expect(isModifierPTTSetting('Space')).toBe(false)
    expect(isModifierPTTSetting('F1')).toBe(false)
    expect(isModifierPTTSetting('KeyK')).toBe(false)
    expect(isModifierPTTSetting(undefined)).toBe(false)
  })
})

describe('computeProcessingTimeoutMs', () => {
  it('preserves the legacy server timeout', () => {
    const ms = computeProcessingTimeoutMs(5, 'server')
    expect(ms).toBeGreaterThanOrEqual(15000)
    expect(ms).toBeLessThan(20000)
  })

  it('cloud_api timeout is at least 30 seconds', () => {
    const ms = computeProcessingTimeoutMs(1, 'cloud_api')
    expect(ms).toBeGreaterThanOrEqual(30000)
  })

  it('legacy local timeout is at least 30 seconds', () => {
    const ms = computeProcessingTimeoutMs(1, 'local')
    expect(ms).toBeGreaterThanOrEqual(30000)
  })

  it('extends timeout for longer audio', () => {
    const short = computeProcessingTimeoutMs(5, 'server')
    const long = computeProcessingTimeoutMs(60, 'server')
    expect(long).toBeGreaterThan(short)
  })

  it('caps cloud_api timeout at 90 seconds', () => {
    const ms = computeProcessingTimeoutMs(600, 'cloud_api')
    expect(ms).toBeLessThanOrEqual(90000)
  })
})

describe('isUnconfirmedPaste', () => {
  it('send_input never reports success from keyboard events alone', () => {
    expect(isUnconfirmedPaste('send_input')).toBe(true)
    expect(isUnconfirmedPaste('send_input', false)).toBe(true)
  })

  it('console and last-resort message delivery remain unconfirmed', () => {
    expect(isUnconfirmedPaste('console_paste')).toBe(true)
    expect(isUnconfirmedPaste('wm_paste_last_resort')).toBe(true)
  })

  it('verification evidence determines success for native message paste', () => {
    expect(isUnconfirmedPaste('wm_paste', false)).toBe(false)
    expect(isUnconfirmedPaste('wm_paste', true)).toBe(true)
    expect(isUnconfirmedPaste(undefined)).toBe(false)
  })
})
