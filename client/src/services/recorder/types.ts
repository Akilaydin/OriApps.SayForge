export type RecorderState = 'idle' | 'recording' | 'processing'
import { t } from '@/i18n'

export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

export type OverlayWidthPreset = 'short' | 'medium' | 'long'

export interface OverlayWidthConfig {
  barCount: number
  windowWidth: number
}

export const OVERLAY_WIDTH_PRESETS: Record<OverlayWidthPreset, OverlayWidthConfig> = {
  short: { barCount: 12, windowWidth: 200 },
  medium: { barCount: 18, windowWidth: 280 },
  long: { barCount: 24, windowWidth: 360 },
}

export interface OverlayCommonPayload {
  theme: OverlayWaveTheme
  showDuration: boolean
  baseWidth?: number
  barCount?: number
  locale?: string
}

export interface PTTEventPayload {
  source?: string
  keycode?: number
  rawcode?: number
  altKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  reason?: string
  pttSetting?: string
  timestamp?: number
}

export const MAX_RECORDING_SEC = 300

export const RECORDING_COUNTDOWN_SEC = 60

export function formatRecordingLimit(): string {
  if (MAX_RECORDING_SEC < 60) return t('duration.seconds', { count: MAX_RECORDING_SEC })
  const minutes = Math.floor(MAX_RECORDING_SEC / 60)
  const seconds = MAX_RECORDING_SEC % 60
  return seconds === 0
    ? t('duration.minutes', { count: minutes })
    : t('duration.minutesSeconds', { minutes, seconds })
}

export function formatRecordingTimer(elapsedSec: number): {
  text: string
  countdown: boolean
  remainingSec: number
} {
  const elapsed = Math.max(0, Math.floor(elapsedSec || 0))
  const remainingSec = Math.max(0, MAX_RECORDING_SEC - elapsed)
  const countdown = remainingSec <= RECORDING_COUNTDOWN_SEC
  return {
    text: countdown ? t('recording.remainingSeconds', { seconds: remainingSec }) : `${elapsed}s`,
    countdown,
    remainingSec,
  }
}
