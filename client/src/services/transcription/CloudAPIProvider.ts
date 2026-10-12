import { invoke } from '@tauri-apps/api/core'
import { loadAsrConfig, type AsrProviderConfig } from './asrConfig'
import { restoreHotwordSpacing } from '../textPostProcess'
import { addRuntimeEvent } from '../debugLog'
import { notifyAsrCapabilityMaybeChanged } from '../bridge'
import { BufferedProvider } from './BufferedProvider'
import type { TranscriptionCallbacks, StartOptions, StopOptions, WorkMode } from './types'

interface AsrResult { text: string; elapsed_ms: number }

export class CloudAPIProvider extends BufferedProvider {
  readonly mode: WorkMode = 'cloud_api'
  private config: Promise<{ value: AsrProviderConfig } | { error: Error }> | undefined

  protected async onConnect(callbacks: TranscriptionCallbacks): Promise<void> {
    callbacks.onReady?.({ asr: true })
  }

  start(opts: StartOptions): boolean {
    const started = super.start({
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
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

    this.callbacks.onFinal?.({ asrText, asrMs, durationSec })
    if (this.isRunCurrent(runId)) this.callbacks.onDone?.()
  }
}
