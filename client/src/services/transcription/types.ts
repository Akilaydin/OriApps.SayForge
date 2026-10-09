
import type { ActiveAppContext, TextContext } from '../../types/appContext'
import type { ClientRuntimeInfo } from '../../types/appApi'
import type { AiConfigSnapshot, AiPolicy } from './aiPolicy'

export type WorkMode = 'cloud_api'

export type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type AiExecutionSource = 'custom' | 'none'
export type AiExecutionStatus = 'applied' | 'skipped' | 'unavailable' | 'failed'

export interface ASRResult {
  text: string
  asrMs: number
  durationSec: number
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
}

export interface FinalResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  /** True only when the AI actually received and processed this run's editor context. */
  contextApplied?: boolean
  /** Explicit execution metadata; text equality cannot prove whether AI ran. */
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
  aiProvider?: string
  aiModel?: string
  aiReason?: string
}

export interface TranscriptionCallbacks {
  onStateChange?: (state: ProviderState) => void
  onReady?: (info: { connectionId?: string; asr: boolean; llm: boolean }) => void
  onASR?: (result: ASRResult) => void
  onFinal?: (result: FinalResult) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

export interface StartOptions {
  runId: number
  operationId?: string
  aiConfig?: AiConfigSnapshot
  systemPrompt?: string
  disableAi?: boolean
  aiMinDurationSec?: number
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  /** Bounded editor text captured at recording start. Never persisted in history/logs. */
  textContext?: TextContext | null
  source?: 'live' | 'history_reprocess'
  hotwords?: string[]
  language?: string
}

export interface StopOptions {
  pttHoldMs?: number
  disableAi?: boolean
  aiPolicy?: AiPolicy
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
