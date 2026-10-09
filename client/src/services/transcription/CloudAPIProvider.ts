import { buildAsrExtra } from '@/lib/asrModels'
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../store'
import { restoreHotwordSpacing } from '../textPostProcess'
import { addRuntimeEvent } from '../debugLog'
import { notifyAsrCapabilityMaybeChanged } from '../bridge'
import { BufferedProvider } from './BufferedProvider'
import { polishWithClientAi } from './clientAiPolish'
import { policyFromSnapshot, resolveAndLogAiOutcome, type AiOutcomeContext } from './aiPolicy'
import type { TranscriptionCallbacks, StartOptions, WorkMode } from './types'

interface AsrProviderConfig {
  provider: string
  api_key: string
  app_id: string
  extra?: Record<string, unknown>
}

interface AsrResult { text: string; elapsed_ms: number }

export class CloudAPIProvider extends BufferedProvider {
  readonly mode: WorkMode = 'cloud_api'

  protected async onConnect(callbacks: TranscriptionCallbacks): Promise<void> {
    callbacks.onReady?.({ asr: true, llm: true })
  }

  start(opts: StartOptions): boolean {
    return super.start({
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    })
  }

  protected async processAudio(audioB64: string, durationSec: number, runId: number): Promise<void> {
    const startOpts = this.startOpts
    if (!startOpts || !this.isRunCurrent(runId)) return
    const asrProvider = await getSetting('cloudAsr.provider', 'openai_compat') as string
    if (!this.isRunCurrent(runId)) return
    const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
    const asrAppId = await getSetting('cloudAsr.appId', '') as string
    const asrModel = await getSetting('cloudAsr.model', '') as string
    if (!this.isRunCurrent(runId)) return

    const asrBaseUrl = await getSetting('cloudAsr.baseUrl', '') as string
    const asrProtocol = await getSetting('cloudAsr.protocol', 'auto') as string
    const asrSystemInstruction = asrProvider === 'openai_compat'
      ? await getSetting('cloudAsr.systemInstruction', '') as string : ''
    const asrUserPrompt = asrProvider === 'openai_compat'
      ? await getSetting('cloudAsr.userPrompt', '') as string : ''
    const asrAudioEncoding = asrProvider === 'openai_compat'
      ? await getSetting('cloudAsr.audioEncoding', 'wav') as string : 'wav'
    if (!this.isRunCurrent(runId)) return

    const extra = buildAsrExtra(asrProvider, {
      model: asrModel,
      instructions: asrSystemInstruction,
      userPrompt: asrUserPrompt,
      audioEncoding: asrAudioEncoding,
      baseUrl: asrBaseUrl,
      protocol: asrProtocol,
    })
    const asrConfig: AsrProviderConfig = {
      provider: asrProvider,
      api_key: asrApiKey,
      app_id: asrAppId,
      ...(extra && { extra }),
    }

    addRuntimeEvent('info', 'cloud_api', 'ASR started', {
      provider: asrProvider,
      model: extra?.model ?? '(provider default)',
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
