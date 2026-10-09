//

import { buildAsrExtra, isStreamingDisplayReady } from '@/lib/asrModels'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getSetting } from '../store'
import { restoreHotwordSpacing } from '../textPostProcess'
import { addRuntimeEvent } from '../debugLog'
import { notifyAsrCapabilityMaybeChanged } from '../bridge'
import { polishWithClientAi } from './clientAiPolish'
import { policyFromSnapshot, resolveAndLogAiOutcome, type AiOutcomeContext } from './aiPolicy'
import type {
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
  WorkMode,
} from './types'

interface AsrProviderConfig {
  provider: string
  api_key: string
  app_id: string
  extra?: Record<string, unknown>
}

interface AsrResult { text: string; elapsed_ms: number }

interface StreamCommandSet {
  open: string
  send: string
  finish: string
  close: string
  streamWithoutRealtime?: boolean
  needsSampleRate?: boolean
  needsWorkspaceId?: boolean
  needsAppId?: boolean
  needsModel?: boolean
}

const STREAM_COMMANDS: Record<string, StreamCommandSet> = {
  openai_live_transcribe: {
    open: 'openai_live_open',
    send: 'openai_live_send',
    finish: 'openai_live_finish',
    close: 'openai_live_close',
    needsModel: true,
  },
  gemini_live_transcribe: {
    open: 'gemini_live_open',
    send: 'gemini_live_send',
    finish: 'gemini_live_finish',
    close: 'gemini_live_close',
    needsModel: true,
  },
}

const ALL_STREAM_CLOSE_COMMANDS = Object.values(STREAM_COMMANDS).map((c) => c.close)

function streamCommandsOf(provider: string): StreamCommandSet | undefined {
  return STREAM_COMMANDS[provider]
}

export class CloudAPIProvider implements TranscriptionProvider {
  readonly mode: WorkMode = 'cloud_api'

  private callbacks: TranscriptionCallbacks = {}
  private pcmBuffers: ArrayBuffer[] = []
  private sessionActive = false
  private activeRunId = 0
  private activeStartOpts: Readonly<StartOptions> | undefined
  private ready = false

  private streamCommands: StreamCommandSet | null = null
  private streamReady = false
  private streamStartTime = 0
  private pendingChunks: ArrayBuffer[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  private partialUnlisten: (() => void) | null = null

  private sendLock: Promise<void> = Promise.resolve()
  private streamFinishing = false

  private nativeLifecycleQueue: Promise<void> = Promise.resolve()

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    this.ready = true
    callbacks.onStateChange?.('connected')
    callbacks.onReady?.({ asr: true, llm: true })
  }

  start(opts: StartOptions): boolean {
    if (!this.ready) {
      addRuntimeEvent('error', 'cloud_api', 'Start failed: provider is not ready')
      return false
    }

    if (this.activeRunId !== 0) this.cancel()

    const runOpts = this.snapshotStartOptions(opts)
    this.pcmBuffers = []
    this.sessionActive = true
    this.activeRunId = runOpts.runId
    this.activeStartOpts = runOpts
    this.streamCommands = null
    this.streamReady = false
    this.streamStartTime = performance.now()
    this.pendingChunks = []
    this.streamFinishing = false
    this.sendLock = Promise.resolve()

    void this.tryStartRealtimeStream(runOpts.runId, runOpts)

    return true
  }

  private snapshotStartOptions(opts: StartOptions): Readonly<StartOptions> {
    return {
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    }
  }

  private isRunCurrent(runId: number): boolean {
    return runId !== 0 && this.activeRunId === runId
  }

  private completeRun(runId: number): void {
    if (!this.isRunCurrent(runId)) return

    this.activeRunId = 0
    this.activeStartOpts = undefined
    const sendLockToDrain = this.sendLock
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.streamFinishing = true
    this.streamCommands = null
    this.streamReady = false
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.teardownPartials()
    void this.queueNativeClose(sendLockToDrain)
  }

  private enqueueNativeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.nativeLifecycleQueue.then(operation)
    this.nativeLifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private queueNativeClose(sendLockToDrain: Promise<void>): Promise<void> {
    return this.enqueueNativeLifecycle(async () => {
      await sendLockToDrain.catch(() => { })
      for (const close of ALL_STREAM_CLOSE_COMMANDS) {
        await invoke(close).catch(() => { })
      }
    })
  }

  private invokeNativeOpen(
    runId: number,
    command: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    return this.enqueueNativeLifecycle(async () => {
      if (!this.isRunCurrent(runId)) return false
      try {
        await invoke(command, args)
      } catch (err) {
        if (!this.isRunCurrent(runId)) return false
        throw err
      }
      if (!this.isRunCurrent(runId)) return false
      return true
    })
  }

  private invokeNativeFinish(
    runId: number,
    command: string,
  ): Promise<string | undefined> {
    return this.enqueueNativeLifecycle(async () => {
      if (!this.isRunCurrent(runId)) return undefined
      try {
        const text = await invoke<string>(command)
        if (!this.isRunCurrent(runId)) return undefined
        return text
      } catch (err) {
        if (!this.isRunCurrent(runId)) return undefined
        throw err
      }
    })
  }

  private async subscribePartials(runId: number): Promise<void> {
    if (this.partialUnlisten) return
    let partialCount = 0
    const unlisten = await listen<{ text?: string }>('asr-partial', (event) => {
      if (!this.isRunCurrent(runId)) return
      if (!this.sessionActive && this.pcmBuffers.length === 0) return
      const text = event.payload?.text ?? ''
      partialCount++
      if (partialCount === 1) {
        addRuntimeEvent('info', 'cloud_api', 'First streaming partial received', { textLen: text.length })
      }
      this.callbacks.onPartialASR?.(text)
    })
    if (!this.isRunCurrent(runId) || this.partialUnlisten) {
      unlisten()
      return
    }
    this.partialUnlisten = unlisten
    addRuntimeEvent('info', 'cloud_api', 'Subscribed to asr-partial events')
  }

  private teardownPartials(): void {
    if (this.partialUnlisten) {
      this.partialUnlisten()
      this.partialUnlisten = null
    }
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.sessionActive) return

    this.pcmBuffers.push(buffer.slice(0))

    if (this.streamCommands && !this.streamFinishing) {
      this.pendingChunks.push(buffer.slice(0))
    }
  }

  stop(_opts?: StopOptions): boolean {
    if (!this.sessionActive) return false
    const runId = this.activeRunId
    const runOpts = this.activeStartOpts
    if (!runOpts || runOpts.runId !== runId) return false
    this.sessionActive = false
    void this.runProcess(runId, runOpts)
    return true
  }

  cancel(): void {
    this.activeRunId = 0
    this.activeStartOpts = undefined
    const sendLockToDrain = this.sendLock
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.streamFinishing = true
    this.streamCommands = null
    this.streamReady = false
    this.teardownPartials()
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    void this.queueNativeClose(sendLockToDrain)
  }

  disconnect(): void {
    this.cancel()
    this.ready = false
    this.callbacks.onStateChange?.('disconnected')
  }

  isReady(): boolean {
    return this.ready
  }



  private async tryStartRealtimeStream(
    runId: number,
    startOpts: Readonly<StartOptions>,
  ): Promise<void> {
    try {
      const asrProvider = await getSetting('cloudAsr.provider', 'openai_compat') as string
      if (!this.isRunCurrent(runId)) return

      const settingOn = Boolean(await getSetting('streamingDisplayEnabled', false))
      if (!this.isRunCurrent(runId)) return
      const realtime = (settingOn || Boolean(startOpts.streamingDisplay)) && isStreamingDisplayReady(asrProvider)
      addRuntimeEvent('info', 'cloud_api', 'Streaming display decision', { asrProvider, settingOn, startOpt: Boolean(startOpts.streamingDisplay), realtime, runId })
      if (realtime) {
        await this.subscribePartials(runId)
        if (!this.isRunCurrent(runId)) return
      }

      const commands = streamCommandsOf(asrProvider)
      if (!commands || (!realtime && !commands.streamWithoutRealtime)) {
        this.teardownPartials()
        return
      }
      this.streamCommands = commands

      const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
      const asrAppId = ''
      const asrModel = commands.needsModel
        ? await getSetting('cloudAsr.model', '') as string
        : ''
      if (!this.isRunCurrent(runId)) return

      const openArgs: Record<string, unknown> = {
        config: {
          provider: asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(asrModel && { extra: { model: asrModel } }),
        },
        hotwords: startOpts.hotwords ?? [],
        realtime,
      }
      if (commands.needsSampleRate) openArgs.sampleRate = 16000

      addRuntimeEvent('info', 'cloud_api', 'Streaming: connecting', {
        asrProvider,
        realtime,
        model: asrModel || '(provider default)',
      })
      const opened = await this.invokeNativeOpen(runId, commands.open, openArgs)
      if (!opened || !this.isRunCurrent(runId)) return
      this.streamReady = true
      addRuntimeEvent('info', 'cloud_api', 'Streaming: ready', { asrProvider })

      await this.flushPendingChunks(runId)
      if (!this.isRunCurrent(runId)) return

      this.flushTimer = setInterval(() => {
        if (!this.isRunCurrent(runId) || this.streamFinishing) return
        if (this.streamReady && this.pendingChunks.length > 0) {
          void this.flushPendingChunks(runId)
        }
      }, 200)
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('warn', 'cloud_api', 'Streaming connection failed; falling back to buffered upload', { error: String(err) })
      this.streamCommands = null
      this.streamReady = false
      this.teardownPartials()
    }
  }

  private flushPendingChunks(runId: number): Promise<void> {
    const run = async () => {
      if (!this.isRunCurrent(runId) || this.pendingChunks.length === 0) return
      const chunks = this.pendingChunks
      this.pendingChunks = []

      const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0)
      const merged = new Uint8Array(totalLen)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), offset)
        offset += chunk.byteLength
      }

      const b64 = uint8ArrayToBase64(merged)
      try {
        if (this.streamCommands) {
          await invoke(this.streamCommands.send, { pcmB64: b64 })
        }
      } catch (err) {
        addRuntimeEvent('warn', 'cloud_api', 'Streaming send failed', { error: String(err) })
      }
    }
    this.sendLock = this.sendLock.then(run, run)
    return this.sendLock
  }


  private async runProcess(
    runId: number,
    startOpts: Readonly<StartOptions>,
  ): Promise<void> {
    const stopTime = performance.now()
    const startTime = this.streamStartTime || stopTime

    try {
      if (!this.isRunCurrent(runId)) return
      const totalBytes = this.pcmBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      if (totalBytes === 0) {
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      const durationSec = (totalBytes / 2) / 16000
      if (durationSec < 0.3) {
        addRuntimeEvent('info', 'cloud_api', 'Audio too short; skipped processing', { durationSec })
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      const asrProvider = await getSetting('cloudAsr.provider', 'openai_compat') as string
      if (!this.isRunCurrent(runId)) return

      let asrText = ''
      let asrMs = 0

      if (this.streamCommands && this.streamReady) {
        const commands = this.streamCommands
        this.streamFinishing = true
        if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
        await this.flushPendingChunks(runId)
        await this.sendLock
        if (!this.isRunCurrent(runId)) return

        addRuntimeEvent('info', 'cloud_api', 'Streaming: sending finish', { command: commands.finish })
        const finishStart = performance.now()
        const text = await this.invokeNativeFinish(runId, commands.finish)
        if (text === undefined || !this.isRunCurrent(runId)) return
        asrText = text
        asrMs = Math.round(performance.now() - finishStart)
        addRuntimeEvent('info', 'cloud_api', 'Streaming: recognition complete', { asrMs, textLen: asrText.length })
      } else {
        const merged = new Uint8Array(totalBytes)
        let offset = 0
        for (const buf of this.pcmBuffers) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }
        const audioB64 = uint8ArrayToBase64(merged)

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
        notifyAsrCapabilityMaybeChanged()
        if (!this.isRunCurrent(runId)) return
        asrText = asrResult.text
        asrMs = asrResult.elapsed_ms
      }

      this.pcmBuffers = []
      this.teardownPartials()

      asrText = restoreHotwordSpacing(asrText, startOpts.hotwords ?? [])

      this.callbacks.onASR?.({ text: asrText, asrMs, durationSec })

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
        this.callbacks.onDone?.()
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

      const totalMs = Math.round(performance.now() - startTime)
      addRuntimeEvent('info', 'cloud_api', 'Processing complete', {
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
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'cloud_api', 'Processing failed', { error: String(err) })
      this.teardownPartials()
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
    } finally {
      this.completeRun(runId)
    }
  }
}
