
import type { ActiveAppContext } from '../../types/appContext'
import type { ClientRuntimeInfo } from '../../types/appApi'

export type WorkMode = 'cloud_api'

export type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'error'


export interface ASRResult {
  text: string
  asrMs: number
  durationSec: number
}

export interface FinalResult {
  asrText: string
  asrMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
}

export interface TranscriptionCallbacks {
  onStateChange?: (state: ProviderState) => void
  onReady?: (info: { connectionId?: string; asr: boolean }) => void
  onASR?: (result: ASRResult) => void
  onFinal?: (result: FinalResult) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

export interface StartOptions {
  runId: number
  operationId?: string
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  source?: 'live' | 'history_reprocess'
  hotwords?: string[]
  language?: string
}

export interface StopOptions {
  pttHoldMs?: number
  audioStats?: {
    avgRms: number
    peakRms: number
    peakAmplitude: number
    silenceRatio: number
    totalFrames: number
  }
}

export interface TranscriptionProvider {
  readonly mode: WorkMode

  connect(callbacks: TranscriptionCallbacks): Promise<void>

  start(opts: StartOptions): boolean

  cancel(): void

  sendAudio(buffer: ArrayBuffer): void

  stop(opts?: StopOptions): boolean

  disconnect(): void

  isReady(): boolean
}
