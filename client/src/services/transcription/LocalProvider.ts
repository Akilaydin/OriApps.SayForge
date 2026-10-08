
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { BufferedProvider } from './BufferedProvider'
import { polishWithClientAi } from './clientAiPolish'
import { policyFromSnapshot, resolveAndLogAiOutcome, type AiOutcomeContext } from './aiPolicy'
import type { TranscriptionCallbacks } from './types'

export class LocalProvider extends BufferedProvider {
  readonly mode = 'local' as const

  protected async onConnect(callbacks: TranscriptionCallbacks): Promise<boolean> {
    const modelId = await getSetting('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf') as string
    if (!modelId) {
      addRuntimeEvent('warn', 'local', 'No local model selected; provider is not ready')
      callbacks.onReady?.({ asr: false, llm: false })
      return false
    }

    let downloaded = false
    try {
      const models = await invoke<{ id: string; complete: boolean }[]>('list_downloaded_models')
      downloaded = models.some((m) => m.id === modelId && m.complete)
    } catch (err) {
      addRuntimeEvent('warn', 'local', 'Could not read local model list; provider is not ready', { error: String(err) })
      callbacks.onReady?.({ asr: false, llm: false })
      return false
    }

    if (!downloaded) {
      addRuntimeEvent('warn', 'local', 'Selected local model is not downloaded; provider is not ready', { modelId })
      callbacks.onReady?.({ asr: false, llm: false })
      return false
    }

    try {
      const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
      const gpuDevice = await getSetting('localAsr.gpuDevice', '') as string
      await invoke<string>('preload_local_model', { modelId, accelerator, gpuDevice })
    } catch (err) {
      addRuntimeEvent('warn', 'local', 'Local model preload failed; provider remains marked ready', { error: String(err) })
    }
    callbacks.onReady?.({ asr: true, llm: false })
    return true
  }

  protected async processAudio(audioB64: string, durationSec: number, runId: number): Promise<void> {
    if (!this.isRunCurrent(runId)) return
    const startOpts = this.startOpts
    const startTime = performance.now()

    addRuntimeEvent('info', 'local', 'Local ASR started', { durationSec, runId })
    let asrText = ''
    let asrMs = 0

    try {
      const modelId = await getSetting('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf')
      if (!this.isRunCurrent(runId)) return
      const language = await getSetting('localAsr.language', 'auto')
      if (!this.isRunCurrent(runId)) return
      const accelerator = await getSetting('localAsr.accelerator', 'auto')
      if (!this.isRunCurrent(runId)) return
      const gpuDevice = await getSetting('localAsr.gpuDevice', '')
      if (!this.isRunCurrent(runId)) return

      const result = await invoke<{ text: string; elapsed_ms: number }>('local_transcribe', {
        audioB64,
        modelId,
        language,
        accelerator,
        gpuDevice,
      })
      if (!this.isRunCurrent(runId)) return
      asrText = result.text
      asrMs = result.elapsed_ms
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'local', 'Local ASR failed', { error: String(err) })
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
      return
    }

    if (!this.isRunCurrent(runId)) return
    this.callbacks.onASR?.({ text: asrText, asrMs, durationSec })

    const policy = policyFromSnapshot(startOpts?.aiConfig, 'local', durationSec)
    const outcomeContext: AiOutcomeContext = {
      operationId: startOpts?.operationId || `local-${runId}`,
      trigger: startOpts?.source === 'history_reprocess' ? 'history_reprocess' : 'live',
    }

    if (!asrText.trim()) {
      if (!this.isRunCurrent(runId)) return
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
      this.callbacks.onDone?.()
      return
    }

    const polish = await polishWithClientAi({
      asrText,
      startOptions: startOpts,
      policy,
      outcomeContext,
      logSource: 'local',
      isCurrent: () => this.isRunCurrent(runId),
    })
    if (!polish || !this.isRunCurrent(runId)) return

    const totalMs = Math.round(performance.now() - startTime)
    addRuntimeEvent('info', 'local', 'Processing complete', {
      durationSec,
      asrMs,
      llmMs: polish.llmMs,
      totalMs,
      runId,
    })

    this.callbacks.onFinal?.({
      asrText,
      asrMs,
      durationSec,
      ...polish,
    })
    this.callbacks.onDone?.()
  }
}
