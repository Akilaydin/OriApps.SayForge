import { invoke } from '@tauri-apps/api/core'
import { loadAsrConfig, type AsrProviderConfig } from './asrConfig'
import { restoreHotwordSpacing } from '../textPostProcess'
import { addRuntimeEvent } from '../debugLog'
import { notifyAsrCapabilityMaybeChanged } from '../bridge'
import { BufferedProvider } from './BufferedProvider'
import { polishWithClientAi } from './clientAiPolish'
import { policyFromSnapshot, resolveAndLogAiOutcome, type AiOutcomeContext } from './aiPolicy'
import type { TranscriptionCallbacks, StartOptions, StopOptions, WorkMode } from './types'

interface AsrResult { text: string; elapsed_ms: number }

export class CloudAPIProvider extends BufferedProvider {
  readonly mode: WorkMode = 'cloud_api'
  private config: Promise<{ value: AsrProviderConfig } | { error: Error }> | undefined

  protected async onConnect(callbacks: TranscriptionCallbacks): Promise<void> {
    callbacks.onReady?.({ asr: true, llm: true })
  }

  start(opts: StartOptions): boolean {
    const started = super.start({
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    })
    if (started) this.config = loadAsrConfig().then(value => ({ value }), error => ({ error }))
    return started
  }

  cancel(): void {
    super.cancel()
    this.config = undefined
  }

  stop(opts?: StopOptions): boolean {
    const pending = this.config
    const stopped = super.stop(opts)
    if (stopped && this.config === pending) this.config = undefined
    return stopped
  }

  protected async processAudio(audioB64: string, durationSec: number, runId: number): Promise<void> {
    const startOpts = this.startOpts
    if (!startOpts || !this.isRunCurrent(runId)) return
    const pending = this.config
    if (!pending) return
    const snapshot = await pending
    if (!this.isRunCurrent(runId)) return
    this.config = undefined
    if ('error' in snapshot) throw snapshot.error
    const asrConfig = snapshot.value

    addRuntimeEvent('info', 'cloud_api', 'ASR started', {
      provider: asrConfig.provider,
      durationSec,
    })
    const asrResult = await invoke<AsrResult>('cloud_transcribe', {
      request: {
        audio_b64: audioB64,
        sample_rate: 16000,
        asr_config: asrConfig,
        hotwords: startOpts.hotwords ?? [],
      },
    })
    if (!this.isRunCurrent(runId)) return
    notifyAsrCapabilityMaybeChanged()
    let asrText = asrResult.text
    const asrMs = asrResult.elapsed_ms


    asrText = restoreHotwordSpacing(asrText, startOpts.hotwords ?? [])

    this.callbacks.onASR?.({ text: asrText, asrMs, durationSec })
    if (!this.isRunCurrent(runId)) return

    const policy = policyFromSnapshot(startOpts.aiConfig, 'cloud_api', durationSec)
    const outcomeContext: AiOutcomeContext = {
      operationId: startOpts.operationId || `cloud-${runId}`,
      trigger: startOpts.source === 'history_reprocess' ? 'history_reprocess' : 'live',
    }

    if (!asrText.trim()) {
      const outcome = resolveAndLogAiOutcome(outcomeContext, policy, { asrTextEmpty: true })
      this.callbacks.onFinal?.({
        asrText: '',
        llmText: '',
        asrMs,
        llmMs: 0,
        durationSec,
        aiSource: outcome.source,
        aiStatus: outcome.status,
      })
      if (this.isRunCurrent(runId)) this.callbacks.onDone?.()
      return
    }

    const polish = await polishWithClientAi({
      asrText,
      startOptions: startOpts,
      policy,
      outcomeContext,
      logSource: 'cloud_api',
      isCurrent: () => this.isRunCurrent(runId),
    })
    if (!polish || !this.isRunCurrent(runId)) return

    this.callbacks.onFinal?.({
      asrText,
      asrMs,
      durationSec,
      ...polish,
    })
    if (this.isRunCurrent(runId)) this.callbacks.onDone?.()
  }
}
