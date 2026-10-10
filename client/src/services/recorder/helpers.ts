
import type { ActiveAppContext } from '@/types/appContext'

export function summarizeAppContext(context: ActiveAppContext | null) {
  if (!context) return null
  return {
    processName: context.processName,
    exePath: context.exePath,
    windowTitle: context.windowTitle,
    windowClass: context.windowClass,
    focusClass: context.focusClass,
    controlType: context.controlType,
    focusedName: context.focusedName,
  }
}

export function buildStatsAppId(
  appContext: ActiveAppContext | null,
  promptAppId?: string,
): string {
  const processName = String(appContext?.processName || '').trim()
  if (processName) return processName

  const exePath = String(appContext?.exePath || '').trim()
  if (exePath) {
    const segments = exePath.split(/[\\/]/).filter(Boolean)
    const lastSegment = segments[segments.length - 1]
    if (lastSegment) return lastSegment
  }

  return String(promptAppId || '').trim() || 'unknown'
}

export type MicLevel = 'muted' | 'low' | 'voiced'

export const MIC_NO_SIGNAL_PEAK_THRESHOLD = 0
export const MIC_LOW_RMS_THRESHOLD = 0.008

export function classifyMicLevel(rms: number, framePeak: number): MicLevel {
  if (framePeak <= MIC_NO_SIGNAL_PEAK_THRESHOLD) return 'muted'
  if (rms < MIC_LOW_RMS_THRESHOLD) return 'low'
  return 'voiced'
}

export const SILENCE_EVIDENCE_MIN_RATIO = 0.995

export function hasSilenceEvidence(stats: {
  totalFrames: number
  silentFrames: number
  peakAmplitude: number
  silenceRmsThreshold: number
}): boolean {
  if (stats.totalFrames <= 0) return false
  const silenceRatio = stats.silentFrames / stats.totalFrames
  return stats.peakAmplitude < stats.silenceRmsThreshold
    && silenceRatio > SILENCE_EVIDENCE_MIN_RATIO
}

export const OS_MIC_MUTE_CONFIRM_SAMPLES = 4800

export type OsMicMuteDecision =
  | { verdict: 'wait'; silentSamples: number }
  | { verdict: 'confirmed' }
  | { verdict: 'dismissed' }

export function judgeOsMicMute(
  silentSamples: number,
  level: MicLevel,
  sampleCount: number,
): OsMicMuteDecision {
  if (level !== 'muted') return { verdict: 'dismissed' }
  const total = silentSamples + sampleCount
  if (total >= OS_MIC_MUTE_CONFIRM_SAMPLES) return { verdict: 'confirmed' }
  return { verdict: 'wait', silentSamples: total }
}

export function isModifierPTTSetting(pttSetting?: string): boolean {
  if (!pttSetting) return false
  return pttSetting.split('+').some((code) => (
    code.startsWith('Alt')
    || code.startsWith('Control')
    || code.startsWith('Shift')
    || code.startsWith('Meta')
  ))
}

export function isUnconfirmedPaste(strategy: string | undefined, uncertain?: boolean): boolean {
  return uncertain === true
    || strategy === 'send_input'
    || strategy === 'console_paste'
    || strategy === 'wm_paste_last_resort'
}

const PROCESSING_TIMEOUT_BASE_MS = 15_000
const PROCESSING_TIMEOUT_PER_AUDIO_SEC_MS = 500
const PROCESSING_TIMEOUT_MAX_EXTRA_MS = 30_000

export function computeProcessingTimeoutMs(
  audioDurationSec: number,
  providerMode: string,
): number {
  const safeAudioSec = Number.isFinite(audioDurationSec) ? Math.max(0, audioDurationSec) : 0
  const extraMs = Math.min(
    PROCESSING_TIMEOUT_MAX_EXTRA_MS,
    Math.ceil(safeAudioSec * PROCESSING_TIMEOUT_PER_AUDIO_SEC_MS),
  )
  let timeout = PROCESSING_TIMEOUT_BASE_MS + extraMs

  if (providerMode !== 'server') {
    timeout = Math.max(timeout, 30000)
  }
  if (providerMode === 'cloud_api') {
    const cloudTimeout = 30000 + Math.ceil(safeAudioSec * 500)
    timeout = Math.min(Math.max(timeout, cloudTimeout), 90000)
  }
  return timeout
}
