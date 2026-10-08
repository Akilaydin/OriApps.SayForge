
import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import * as ws from '../websocket'
import { polishWithClientAi } from './clientAiPolish'
import {
  resolveAiPolicy,
  resolveAndLogAiOutcome,
  type AiOutcomeContext,
  type AiPolicy,
} from './aiPolicy'
import {
  getRuntimeServerAiSource,
  loadServerAiSource,
  type ServerAiSource,
} from './serverAiSource'
import { MID_SESSION_DISCONNECT_ERROR } from './types'
import type {
  FinalResult,
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
} from './types'

export class ServerProvider implements TranscriptionProvider {
  readonly mode = 'server' as const

  private callbacks: TranscriptionCallbacks = {}
  private activeRunId = 0
  private activeStartOpts: Readonly<StartOptions> | undefined
  private aiSource: ServerAiSource = 'managed'
  private customAiReady = false
  private customFinalPending = false
  private serverDonePending = false
  private activePolicy: AiPolicy | undefined
  private activeConnectionId: string | undefined

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    const [storedSource, customProvider, customUrl, customKey, customModel] = await Promise.all([
      loadServerAiSource(),
      getSetting('cloudAi.provider', '') as Promise<string>,
      getSetting('cloudAi.apiUrl', '') as Promise<string>,
      getSetting('cloudAi.apiKey', '') as Promise<string>,
      getSetting('cloudAi.model', '') as Promise<string>,
    ])
    this.aiSource = storedSource === 'custom' ? 'custom' : 'managed'
    this.customAiReady = Boolean(
      customUrl.trim()
      && customModel.trim()
      && (customKey.trim() || customProvider === 'ollama'),
    )

    await ws.connect({
      onStateChange: (state) => {
        callbacks.onStateChange?.(state)
        //
        if (state !== 'disconnected' && state !== 'error') return
        const runId = this.activeRunId
        if (runId === 0) return
        addRuntimeEvent('error', 'server', 'Connection dropped during an active recording', {
          runId,
          state,
        })
        this.resetRun()
        callbacks.onError?.(MID_SESSION_DISCONNECT_ERROR)
      },
      onReady: (data) => {
        this.activeConnectionId = data.connectionId
        callbacks.onReady?.({
          connectionId: data.connectionId,
          asr: data.asr,
          llm: this.aiSource === 'custom' ? this.customAiReady : data.llm,
        })
      },
      onASR: (result) => {
        if (this.activeRunId === 0) return
        const isEmpty = !result.text.trim()
        callbacks.onASR?.({
          text: result.text,
          asrMs: result.asrMs,
          durationSec: result.durationSec,
          aiSource: isEmpty ? 'none' : undefined,
          aiStatus: isEmpty ? 'skipped' : undefined,
        })
      },
      onFinal: (result) => {
        const runId = this.activeRunId
        if (runId === 0) return
        if (this.aiSource === 'custom') {
          this.customFinalPending = true
          void this.handleCustomFinal(runId, result)
          return
        }

        const policy = this.resolvePolicy(result.durationSec)
        const outcome = resolveAndLogAiOutcome(this.outcomeContext(), policy, {
          asrTextEmpty: !result.asrText.trim(),
          serverError: result.serverAi?.error,
          serverProvider: result.serverAi?.provider,
          llmMs: result.llmMs,
        })
        callbacks.onFinal?.({
          asrText: result.asrText,
          llmText: result.llmText,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
          durationSec: result.durationSec,
          asrEngine: result.asrEngine,
          asrModel: result.asrModel,
          contextApplied: result.contextApplied,
          aiSource: outcome.source,
          aiStatus: outcome.status,
          aiProvider: outcome.provider,
        })
      },
      onDone: () => {
        const runId = this.activeRunId
        if (runId === 0) return
        if (this.customFinalPending) {
          this.serverDonePending = true
          return
        }
        this.finishRun(runId)
      },
      onError: (msg) => {
        const runId = this.activeRunId
        if (runId === 0) return
        callbacks.onError?.(msg)
        if (this.activeRunId === runId) this.resetRun()
      },
    })
  }

  start(opts: StartOptions): boolean {
    this.aiSource = getRuntimeServerAiSource()
    this.activeRunId = opts.runId
    this.activeStartOpts = {
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    }
    this.customFinalPending = false
    this.serverDonePending = false

    const wireOptions = this.aiSource === 'custom'
      ? {
        ...opts,
        disableAi: true,
        systemPrompt: undefined,
        textContext: undefined,
      }
      : opts
    const started = ws.sendStart(wireOptions)
    if (!started) this.resetRun()
    return started
  }

  cancel(): void {
    this.resetRun()
    ws.disconnect()
  }

  sendAudio(buffer: ArrayBuffer): void {
    ws.sendAudio(buffer)
  }

  stop(opts?: StopOptions): boolean {
    if (opts?.aiPolicy) this.activePolicy = opts.aiPolicy
    return ws.sendStop(this.aiSource === 'custom' ? { ...opts, disableAi: true } : opts)
  }

  private resolvePolicy(durationSec: number): AiPolicy {
    if (this.activePolicy) return this.activePolicy
    const snapshot = this.activeStartOpts?.aiConfig
    const fallback = resolveAiPolicy({
      workMode: 'server',
      aiEnabled: snapshot?.aiEnabled ?? !(this.activeStartOpts?.disableAi ?? false),
      aiMinDurationSec: snapshot?.aiMinDurationSec ?? this.activeStartOpts?.aiMinDurationSec ?? 0,
      serverAiSource: snapshot?.serverAiSource ?? this.aiSource,
      audioDurationSec: durationSec,
    })
    this.activePolicy = fallback
    return fallback
  }

  private outcomeContext(): AiOutcomeContext {
    return {
      operationId: this.activeStartOpts?.operationId || `run-${this.activeRunId}`,
      trigger: this.activeStartOpts?.source === 'history_reprocess' ? 'history_reprocess' : 'live',
      serverRef: this.activeConnectionId,
    }
  }

  disconnect(): void {
    this.resetRun()
    ws.disconnect()
  }

  isReady(): boolean {
    return ws.isConnected()
  }

  private async handleCustomFinal(runId: number, result: FinalResult): Promise<void> {
    const startOptions = this.activeStartOpts
    const polished = await polishWithClientAi({
      asrText: result.asrText,
      startOptions,
      policy: this.resolvePolicy(result.durationSec),
      outcomeContext: this.outcomeContext(),
      logSource: 'server',
      isCurrent: () => this.activeRunId === runId,
    })
    if (!polished || this.activeRunId !== runId) return

    this.callbacks.onFinal?.({
      ...result,
      ...polished,
    })
    this.customFinalPending = false

    if (this.serverDonePending) {
      this.finishRun(runId)
    }
  }

  private finishRun(runId: number): void {
    if (this.activeRunId !== runId) return
    this.callbacks.onDone?.()
    if (this.activeRunId === runId) this.resetRun()
  }

  private resetRun(): void {
    if (this.activeRunId !== 0 && this.customFinalPending) {
      addRuntimeEvent('info', 'server', 'Discarded pending custom AI result for stale run', {
        runId: this.activeRunId,
      })
    }
    this.activeRunId = 0
    this.activeStartOpts = undefined
    this.activePolicy = undefined
    this.customFinalPending = false
    this.serverDonePending = false
  }
}
