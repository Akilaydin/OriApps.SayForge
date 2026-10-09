import * as bridge from '../bridge'
import { startCapture, stopCapture } from '../audio'
import { getProvider, type TranscriptionProvider, type TranscriptionCallbacks, type FinalResult } from '../transcription'
import { resolveAiPolicy, type AiConfigSnapshot } from '../transcription/aiPolicy'
import { isStreamingDisplayReady, resolveAsrDisplayModel } from '@/lib/asrModels'
import {
  addHistory,
  deleteHistory,
  getActivePresetId,
  getPromptPresets,
  getSetting,
  setActivePresetId,
  updateHistoryRecord,
  type HistoryFailReasonCode,
  type HistoryRecord,
  type PromptPreset,
} from '../store'
import { setActivePresetKnown } from '../../stores/activePreset'
import { addRuntimeEvent } from '../debugLog'
import { saveRecordingAudio } from '../audioFileService'
import {
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_WORDS_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  composeHotwords,
  normalizeBuiltinSetActive,
  normalizeBuiltinSetWords,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
} from '../hotwords/model'
import { invoke } from '@tauri-apps/api/core'
import { createWaveformBarState, computeBarsFromPCM, resetWaveformBarState } from '../waveform'
import { elapsedSecFromPerf } from '../timeModel'
import {
  captureActiveInsertionTarget,
  clearCapturedInsertionTarget,
  startInsertionTargetTracking,
  stopInsertionTargetTracking,
} from '../textInsertion'
import { applyTextTransforms } from '../textPostProcess'
import type { ActiveAppContext } from '../../types/appContext'
import type { ClientRuntimeInfo } from '../../types/appApi'
import { OverlayService, type FailureRecovery } from './OverlayService'
import { PasteService, type ProbeResult } from './PasteService'
import { createDefaultUserStats } from '../personalization/defaults'
import { resolvePromptRouting } from '../personalization/promptRouter'
import {
  getAppPromptRules,
  getUserStats,
  recordSessionStats,
} from '../personalization/store'
import type { AppPromptRule, PromptResolution, UserStats } from '../personalization/types'
import type { PTTEventPayload, RecorderState } from './types'
import { MAX_RECORDING_SEC, RECORDING_COUNTDOWN_SEC } from './types'
import {
  summarizeAppContext as _summarizeAppContext,
  buildStatsAppId as _buildStatsAppId,
  isModifierPTTSetting as _isModifierPTTSetting,
  computeProcessingTimeoutMs as _computeProcessingTimeoutMs,
  classifyMicLevel,
  judgeOsMicMute,
  hasSilenceEvidence,
  isUnconfirmedPaste,
  type MicLevel,
} from './helpers'
import { t } from '@/i18n'
import { describeProviderError } from '@/lib/errorMessages'
import { describeMicSource, micSourceChanged } from './micSourceReminder'
import {
  CONTEXT_SELECTION_EDIT_PROMPT,
  CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY,
  normalizeContextSelectionEditPrompt,
  resolveContextAwareOutput,
  usableTextContext,
  withContextAwareInstructions,
} from '../contextAware'

type StateTransition =
  | ['idle', 'recording']
  | ['recording', 'processing']
  | ['recording', 'idle']
  | ['processing', 'idle']

const VALID_TRANSITIONS: StateTransition[] = [
  ['idle', 'recording'],
  ['recording', 'processing'],
  ['recording', 'idle'],
  ['processing', 'idle'],
]

const LATE_FINAL_GRACE_MS = 15000
const AUDIO_ARCHIVE_WAIT_MS = 30_000
const INSERTION_TIMEOUT_EXTENSION_MS = 5000
const INSERTION_TIMEOUT_MS = 15000
const MAX_INSERTION_TIMEOUT_EXTENSIONS = 3
const MODIFIER_PTT_RELEASE_GUARD_MS = 200
const MIC_MUTED_AUTO_CANCEL_MS = 3000

function classifyHistoryProviderFailure(message: string): HistoryFailReasonCode {
  const code = describeProviderError(message).code
  switch (code) {
    case 'provider_timeout':
    case 'provider_unreachable':
    case 'provider_bad_key':
    case 'provider_forbidden':
    case 'provider_rate_limit':
    case 'provider_no_model':
      return code
    default:
      return 'provider_failed'
  }
}

interface TimedOutProcessingContext {
  runId: number
  timedOutAt: number
  settled: boolean
  audioDurationSec: number
  wallTimeSec: number
  promptResolution: PromptResolution | null
  appContext: ActiveAppContext | null
  audioChunks: ArrayBuffer[]
  probeResult: ProbeResult | null
}

interface ResetToIdleOptions {
  keepOverlay?: boolean
  preserveLateFinalContext?: boolean
}

type HistoryMetadata = Pick<
  HistoryRecord,
  | 'appId'
  | 'appName'
  | 'windowTitle'
  | 'processName'
  | 'windowClass'
  | 'promptPresetId'
  | 'promptPresetName'
  | 'promptRuleId'
  | 'promptSummary'
  | 'workMode'
>

interface AudioArchive {
  runId: number
  recordId: string
  promise: Promise<string | null>
  discarded: boolean
}

export class RecorderOrchestrator {
  private state: RecorderState = 'idle'
  private onStateChange: ((s: RecorderState) => void) | null = null
  private initialized = false
  private runSequence = 0
  private activeRunId = 0

  private recordStartPerf = 0
  private audioSentSamples = 0
  /** Wall time captured at stopRecording — used for history durationSec so it
   *  matches what the user saw on the overlay (not inflated by backend latency). */
  private wallTimeAtStopSec = 0
  private finalHandledInCurrentRun = false
  private textInsertionInFlight = false
  private textBeingInserted = ''
  private lateResultAbandoned = false
  private lateResultRunId = 0
  private finalizingLateRunId = 0
  private processingCancelable = false
  private activeFallbackToken = 0
  /** Guard against re-entrant startRecording calls during async setup */
  private startRecordingLock = false
  /** PTT up arrived while startRecording was still initializing — stop immediately after setup */
  private pendingStopWhileStarting = false
  private processingTimeoutId: ReturnType<typeof setTimeout> | null = null
  private insertionTimeoutId: ReturnType<typeof setTimeout> | null = null
  private finalReceivedAt = 0
  private timedOutProcessingContext: TimedOutProcessingContext | null = null
  private pendingHistoryArtifact: { runId: number; recordId: string; audioFilePath?: string } | null = null
  private audioArchives = new Map<number, AudioArchive>()
  private canceledRuns = new Set<number>()

  private handsFreeMode = false
  private pttSuppressed = false
  private lastToggleTime = 0
  private lastPTTUpAt = 0
  private lastPTTUpUsedModifier = false

  private cachedMicId = ''
  /** Last successfully opened input route in this app process. Kept in memory on purpose. */
  private lastMicSourceIdentity: string | null = null
  private noiseSuppression = true
  private cachedMuteSystemAudio = false
  private cachedProtectClipboard = true
  private systemMuteApplied = false
  private systemMuteTimerId: ReturnType<typeof setTimeout> | null = null
  private cachedPresets: PromptPreset[] = []
  private cachedActivePresetId = 'intent'
  private cachedAiEnabled = true
  private cachedAiMinDurationSec = 0
  private currentAiConfig: AiConfigSnapshot | undefined
  private currentOperationId: string | undefined
  /** Reads bounded editor text only when explicitly enabled; default is false. */
  private cachedContextAwareWriting = false
  /** User-visible selection-edit prompt. Cached with other recording settings. */
  private cachedContextSelectionEditPrompt = CONTEXT_SELECTION_EDIT_PROMPT
  private cachedClientRuntimeInfo: ClientRuntimeInfo | null = null
  private clientRuntimeInfoLoaded = false
  private cachedAppPromptRules: AppPromptRule[] = []
  private cachedUserStats: UserStats = createDefaultUserStats()
  private cachedHotwords: string[] = []
  private cachedInjectHotwords = false
  private cachedLanguage: string = ''
  private cachedStreamingDisplay = false
  private currentActiveAppContext: ActiveAppContext | null = null
  private currentPromptResolution: PromptResolution | null = null
  /** Probe result captured at startRecording time (before audio capture begins).
   *  Used by handleTextInsertion so we inject into the window that was focused
   *  when the user started speaking, not whatever happens to be focused later. */
  private cachedProbeResult: import('./PasteService').ProbeResult | null = null

  private readonly overlayWaveState = createWaveformBarState()
  private readonly overlayService = new OverlayService(() => this.getLiveElapsedSec())
  private readonly pasteService = new PasteService()
  private get provider(): TranscriptionProvider { return getProvider() }
  private recordedChunks: ArrayBuffer[] = []
  private captureReadyPromise: Promise<void> | null = null
  /** 5-minute auto-stop timer for hands-free mode */
  private handsFreeAutoStopId: ReturnType<typeof setTimeout> | null = null
  private micMutedAutoCancelId: ReturnType<typeof setTimeout> | null = null
  private micMuteProbeSequence = 0
  private consecutiveSilentSamples = 0
  private consecutiveNonVoicedSamples = 0
  private quietRunSawSignal = false
  private consecutiveVoicedSamples = 0
  private currentVolumeWarning: 'none' | 'muted' | 'low' = 'none'
  private hasDetectedVoiceThisSession = false
  private lastLowVolumeWarnAt = 0
  private osMicMuted = false
  private pendingOsMicMuted = false
  private pendingOsMicMutedSamples = 0

  /** Audio stats tracking */
  private audioStatsRmsSum = 0
  private audioStatsPeakRms = 0
  private audioStatsPeakAmplitude = 0
  private audioStatsSilentFrames = 0
  private audioStatsTotalFrames = 0
  private static readonly SILENCE_RMS_THRESHOLD = 0.01

  setStateListener(cb: (s: RecorderState) => void) {
    this.onStateChange = cb
  }

  getState() {
    return this.state
  }

  private isRunCurrent(runId: number) {
    return runId !== 0 && this.activeRunId === runId
  }

  private markRunCanceled(runId: number) {
    if (runId === 0) return
    this.canceledRuns.add(runId)
    if (this.canceledRuns.size > 64) {
      for (const id of this.canceledRuns) {
        if (this.canceledRuns.size <= 32) break
        this.canceledRuns.delete(id)
      }
    }
  }

  private isRunCanceled(runId: number) {
    return runId === 0 || this.canceledRuns.has(runId)
  }

  private beginAudioArchive(runId: number, chunks: ArrayBuffer[]): string {
    const recordId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const promise = (async (): Promise<string | null> => {
      try {
        if (chunks.length === 0) return null
        const [historyEnabled, retentionEnabled] = await Promise.all([
          getSetting('historyEnabled', true),
          getSetting('audioRetentionEnabled', true),
        ])
        if (!historyEnabled || !retentionEnabled) return null
        const savedPath = await saveRecordingAudio(recordId, chunks)
        addRuntimeEvent('info', 'recorder', 'Recording audio archived', {
          runId,
          recordId,
          saved: Boolean(savedPath),
          chunks: chunks.length,
        })
        return savedPath
      } catch (error) {
        addRuntimeEvent('warn', 'recorder', 'Failed to archive recording audio', {
          runId,
          recordId,
          error: String(error),
        })
        return null
      }
    })()
    this.audioArchives.set(runId, { runId, recordId, promise, discarded: false })
    if (this.audioArchives.size > 8) {
      const oldest = this.audioArchives.keys().next()
      if (!oldest.done) this.audioArchives.delete(oldest.value)
    }
    return recordId
  }

  private ensureAudioArchive(runId: number, chunks: ArrayBuffer[]): void {
    if (this.audioArchives.has(runId)) return
    this.beginAudioArchive(runId, chunks)
  }

  private async takeArchivedAudio(
    runId: number,
  ): Promise<{ recordId: string; audioFilePath?: string; pendingLate?: boolean } | null> {
    const archive = this.audioArchives.get(runId)
    if (!archive) return null
    this.audioArchives.delete(runId)
    let timedOutWaiting = false
    const savedPath = await Promise.race([
      archive.promise,
      new Promise<null>((resolve) => setTimeout(() => {
        timedOutWaiting = true
        resolve(null)
      }, AUDIO_ARCHIVE_WAIT_MS)),
    ])
    if (archive.discarded) return null
    if (timedOutWaiting) {
      addRuntimeEvent('warn', 'recorder', 'Audio archive did not finish in time; writing history without the audio path', {
        runId,
        recordId: archive.recordId,
        waitedMs: AUDIO_ARCHIVE_WAIT_MS,
      })
      void archive.promise.then(async (latePath) => {
        if (!latePath || archive.discarded) return
        try {
          await updateHistoryRecord(archive.recordId, { audioFilePath: latePath })
          void bridge.emit('history-updated')
          addRuntimeEvent('info', 'recorder', 'Attached late audio archive to its history record', {
            recordId: archive.recordId,
          })
          this.overlayService.updateFailureRecovery('history', archive.runId)
        } catch (error) {
          addRuntimeEvent('warn', 'recorder', 'Failed to attach late audio archive', {
            recordId: archive.recordId,
            error: String(error),
          })
        }
      })
      return { recordId: archive.recordId, pendingLate: true }
    }
    return { recordId: archive.recordId, audioFilePath: savedPath ?? undefined }
  }

  private discardAudioArchive(runId: number) {
    const archive = this.audioArchives.get(runId)
    if (!archive || archive.discarded) return
    archive.discarded = true
    this.audioArchives.delete(runId)
    void archive.promise.then((savedPath) => {
      if (!savedPath) return
      void bridge.deleteAudioFile(savedPath).catch(() => {  })
    })
  }

  private async archiveFailedRun(params: {
    runId: number
    audioDurationSec: number
    wallTimeSec: number
    asrMs?: number
    asrDurationSec?: number
    failReason?: string
    failReasonCode?: HistoryFailReasonCode
    historyMeta: HistoryMetadata
    aiSource?: HistoryRecord['aiSource']
    aiStatus?: HistoryRecord['aiStatus']
  }): Promise<FailureRecovery> {
    const { runId } = params
    let artifact: { recordId: string; audioFilePath?: string; pendingLate?: boolean } | null = null
    try {
      const historyEnabled = await getSetting('historyEnabled', true)
      if (!historyEnabled) return 'none'
      artifact = await this.takeArchivedAudio(runId)
      if (!artifact) return 'none'
      if (this.isRunCanceled(runId)) {
        await this.discardCanceledHistory(artifact)
        return 'none'
      }
      this.pendingHistoryArtifact = { runId, ...artifact }
      await addHistory({
        ...params.historyMeta,
        id: artifact.recordId,
        timestamp: Date.now(),
        asrText: '',
        llmText: '',
        asrMs: params.asrMs ?? 0,
        llmMs: 0,
        durationSec: params.wallTimeSec,
        audioDurationSec: params.audioDurationSec > 0 ? params.audioDurationSec : undefined,
        asrDurationSec: params.asrDurationSec,
        charCount: 0,
        isEmpty: true,
        failReason: params.failReason,
        failReasonCode: params.failReasonCode,
        aiSource: params.aiSource,
        aiStatus: params.aiStatus,
        audioFilePath: artifact.audioFilePath,
      })
      if (this.isRunCanceled(runId)) {
        await this.discardCanceledHistory(artifact)
        return 'none'
      }
      void bridge.emit('history-updated')
      addRuntimeEvent('info', 'recorder', 'Saved recording to history without text', {
        runId,
        recordId: artifact.recordId,
        audioSaved: Boolean(artifact.audioFilePath),
        audioSec: params.audioDurationSec,
        failReasonCode: params.failReasonCode,
      })
      //
      if (artifact.audioFilePath) return 'history'
      return artifact.pendingLate ? 'unknown' : 'none'
    } catch (error) {
      if (artifact) await this.discardCanceledHistory(artifact)
      addRuntimeEvent('warn', 'recorder', 'Failed to save recording to history', {
        runId,
        error: String(error),
        failReasonCode: params.failReasonCode,
      })
      return 'none'
    }
  }

  private hasSilenceEvidence(): boolean {
    return hasSilenceEvidence({
      totalFrames: this.audioStatsTotalFrames,
      silentFrames: this.audioStatsSilentFrames,
      peakAmplitude: this.audioStatsPeakAmplitude,
      silenceRmsThreshold: RecorderOrchestrator.SILENCE_RMS_THRESHOLD,
    })
  }

  private async failRunWithCard(runId: number, params: {
    title: string
    detail?: string
    audioDurationSec: number
    wallTimeSec: number
    failReason: string
    failReasonCode: HistoryFailReasonCode
    historyMeta: HistoryMetadata
    asrMs?: number
    asrDurationSec?: number
    aiSource?: HistoryRecord['aiSource']
    aiStatus?: HistoryRecord['aiStatus']
  }): Promise<void> {
    const showCard = this.isRunCurrent(runId)
    if (showCard) {
      this.activeFallbackToken = runId
      this.overlayService.showFailure({
        title: params.title,
        detail: params.detail,
        recovery: 'unknown',
        token: runId,
      })
    }

    const recovery = await this.archiveFailedRun({
      runId,
      audioDurationSec: params.audioDurationSec,
      wallTimeSec: params.wallTimeSec,
      asrMs: params.asrMs,
      asrDurationSec: params.asrDurationSec,
      failReason: params.failReason,
      failReasonCode: params.failReasonCode,
      historyMeta: params.historyMeta,
      aiSource: params.aiSource,
      aiStatus: params.aiStatus,
    })
    if (showCard) this.overlayService.updateFailureRecovery(recovery, runId)
  }

  private async failRunWithoutResult(runId: number, params: {
    audioDurationSec: number
    wallTimeSec: number
    failReason: string
    failReasonCode: HistoryFailReasonCode
    title: string
    detail?: string
  }): Promise<void> {
    this.clearProcessingTimeout()
    this.processingCancelable = false
    const historyMeta = this.buildHistoryMetadata(
      this.currentPromptResolution,
      this.currentActiveAppContext,
    )
    addRuntimeEvent('warn', 'recorder', 'Run failed without any result', {
      runId,
      audioSec: params.audioDurationSec,
      failReasonCode: params.failReasonCode,
      mode: this.provider.mode,
    })
    this.provider.cancel()

    await this.failRunWithCard(runId, {
      title: params.title,
      detail: params.detail,
      audioDurationSec: params.audioDurationSec,
      wallTimeSec: params.wallTimeSec,
      failReason: params.failReason,
      failReasonCode: params.failReasonCode,
      historyMeta,
    })
    if (!this.isRunCurrent(runId)) return
    this.finishRun(runId)
    this.resetToIdle({ keepOverlay: true })
  }

  private finishRun(runId: number) {
    if (runId === 0) return
    if (this.pendingHistoryArtifact?.runId === runId) {
      this.pendingHistoryArtifact = null
    }
    if (this.timedOutProcessingContext?.runId === runId) {
      this.timedOutProcessingContext = null
    }
    if (this.activeRunId === runId) {
      this.activeRunId = 0
      this.processingCancelable = false
    }
  }

  private scheduleSystemMuteIfEnabled() {
    if (!this.cachedMuteSystemAudio) return
    this.clearSystemMuteTimer()
    this.systemMuteTimerId = setTimeout(() => {
      this.systemMuteTimerId = null
      if (this.state !== 'recording') return
      this.applySystemMute()
    }, 250)
  }

  private applySystemMute() {
    if (this.systemMuteApplied) return
    this.systemMuteApplied = true
    void bridge.muteSystemOutput().catch((e) => {
      this.systemMuteApplied = false
      addRuntimeEvent('warn', 'recorder', 'Failed to mute system audio', { error: String(e) })
    })
  }

  private clearSystemMuteTimer() {
    if (this.systemMuteTimerId) {
      clearTimeout(this.systemMuteTimerId)
      this.systemMuteTimerId = null
    }
  }

  private restoreSystemMuteIfNeeded() {
    this.clearSystemMuteTimer()
    if (!this.systemMuteApplied) return
    this.systemMuteApplied = false
    void bridge.restoreSystemOutput().catch((e) => {
      addRuntimeEvent('warn', 'recorder', 'Failed to restore system audio', { error: String(e) })
    })
  }

  private notReadyMessage(): string {
    switch (this.provider.mode) {
      case 'local':
        return t('recorder.modelNotDownloaded')
      default:
        return t('recorder.serviceNotReady')
    }
  }

  private async handlePresetSwitch(presetId: string) {
    try {
      let target = this.cachedPresets.find((p) => p.id === presetId)
      if (!target) {
        const presets = await getPromptPresets()
        target = presets.find((p) => p.id === presetId)
        this.cachedPresets = presets
      }
      if (!target) {
        addRuntimeEvent('warn', 'recorder', 'Failed to switch cleanup preset: preset not found', { presetId })
        return
      }
      this.cachedActivePresetId = presetId
      setActivePresetKnown(presetId, target.name)
      if (this.state === 'idle') {
        this.overlayService.showPresetSwitched(target.name)
      }
      addRuntimeEvent('info', 'recorder', 'Cleanup preset switched by shortcut', { presetId, name: target.name })
      void setActivePresetId(presetId)
    } catch (error) {
      addRuntimeEvent('error', 'recorder', 'Cleanup preset switch failed', { error: String(error) })
    }
  }

  setPttSuppressed(suppressed: boolean) {
    this.pttSuppressed = suppressed
  }

  async init() {
    if (this.initialized) return
    this.initialized = true

    startInsertionTargetTracking()
    await this.refreshRuntimeSettings()
    void this.ensureClientRuntimeInfo()
    this.ensureConnection()

    void bridge.listen('switch-preset', (event: unknown) => {
      const payload = (event as { payload?: { presetId?: string } })?.payload
      const presetId = payload?.presetId
      if (presetId) void this.handlePresetSwitch(presetId)
    })

    bridge.onEscapeAction(({ mode, token }) => {
      if (mode === 'cancel_recording') {
        if (this.state === 'processing' && this.processingCancelable) {
          this.cancelProcessing(token)
        } else {
          void this.cancelRecording(token)
        }
        return
      }
      if (mode === 'cancel_processing') {
        this.cancelProcessing(token)
        return
      }
      if (mode === 'dismiss_fallback') {
        if (token === 0 || token !== this.activeFallbackToken) {
          addRuntimeEvent('info', 'recorder', 'Ignored stale Esc fallback dismissal', {
            token,
            activeFallbackToken: this.activeFallbackToken,
          })
          return
        }
        addRuntimeEvent('info', 'recorder', 'Card dismissed with Esc', { token })
        this.activeFallbackToken = 0
        if (token === this.lateResultRunId) {
          this.lateResultAbandoned = true
        }
        this.overlayService.hide()
        return
      }
      if (mode === 'abandon_late_result') {
        //
        if (token === 0 || token !== this.lateResultRunId) {
          addRuntimeEvent('info', 'recorder', 'Ignored stale Esc for late-result abandonment', {
            token,
            lateResultRunId: this.lateResultRunId,
          })
          return
        }
        addRuntimeEvent('info', 'recorder', 'User abandoned waiting for the late result', { token })
        this.lateResultAbandoned = true
        this.overlayService.hide()
      }
    })

    bridge.onCardDismissed(({ reason, token }) => {
      addRuntimeEvent('info', 'recorder', 'Overlay reported a dismissed card', { reason, token })
      this.overlayService.noteCardDismissed(token)
      if (token !== 0 && token === this.activeFallbackToken) {
        this.activeFallbackToken = 0
      }
      if (token !== 0 && token === this.lateResultRunId) {
        this.lateResultAbandoned = true
      }
    })

    bridge.onPTTDown((payload) => {
      this.notePTTDown(payload)
      this.logPTTEvent('down', payload)
      if (this.pttSuppressed || this.handsFreeMode) {
        addRuntimeEvent('info', 'ptt', 'event:down ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: this.pttSuppressed ? 'ptt_suppressed' : 'hands_free_mode',
        })
        return
      }
      if (this.state === 'idle') {
        addRuntimeEvent('info', 'ptt', 'event:down accepted -> startRecording', this.getPTTEventContext(payload))
        void this.startRecording()
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:down ignored', {
        ...this.getPTTEventContext(payload),
        ignoreReason: 'state_not_idle',
      })
    })

    bridge.onPTTUp((payload) => {
      this.notePTTUp(payload)
      this.logPTTEvent('up', payload)
      if (this.pttSuppressed || this.handsFreeMode) {
        addRuntimeEvent('info', 'ptt', 'event:up ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: this.pttSuppressed ? 'ptt_suppressed' : 'hands_free_mode',
        })
        return
      }
      if (this.state === 'recording') {
        addRuntimeEvent('info', 'ptt', 'event:up accepted -> stopRecording', this.getPTTEventContext(payload))
        void this.stopRecording()
        return
      }
      // PTT up arrived while startRecording is still initializing (state is still 'idle')
      if (this.startRecordingLock) {
        addRuntimeEvent('info', 'ptt', 'event:up deferred — startRecording in progress', this.getPTTEventContext(payload))
        this.pendingStopWhileStarting = true
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:up ignored', {
        ...this.getPTTEventContext(payload),
        ignoreReason: 'state_not_recording',
      })
    })

    bridge.onPTTToggle((payload) => {
      this.logPTTEvent('toggle', payload)
      if (this.pttSuppressed || this.handsFreeMode) {
        addRuntimeEvent('info', 'ptt', 'event:toggle ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: this.pttSuppressed ? 'ptt_suppressed' : 'hands_free_mode',
        })
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:toggle accepted', this.getPTTEventContext(payload))
      this.pttToggle(false)
    })

    bridge.onToggleHandsFree((payload) => {
      this.logPTTEvent('hands_free', payload)
      if (this.pttSuppressed) {
        addRuntimeEvent('info', 'ptt', 'event:hands_free ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: 'ptt_suppressed',
        })
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:hands_free accepted', this.getPTTEventContext(payload))
      this.pttToggle(true)
    })

    // 9-minute warning from Rust keyboard hook (PTT hold mode)
    bridge.onPTTTimeoutWarning(() => {
      if (this.state === 'recording') {
        addRuntimeEvent('warn', 'recorder', 'Recording is approaching the five-minute limit')
        this.overlayService.showTimeoutWarning()
      }
    })
  }

  cleanup() {
    this.clearProcessingTimeout()
    this.clearMicMutedAutoCancelTimer()
    this.micMuteProbeSequence++
    this.overlayService.dispose()
    stopInsertionTargetTracking()
    void stopCapture().catch(() => { })
    this.provider.disconnect()
  }

  setAiEnabledCache(next: boolean) {
    this.cachedAiEnabled = next
  }

  showAiEnabledToast(enabled: boolean) {
    if (this.state === 'idle') this.overlayService.showAiCleanupToggled(enabled)
  }

  setActivePresetCache(id: string) {
    this.cachedActivePresetId = id
  }

  setPromptPresetsCache(presets: PromptPreset[]) {
    this.cachedPresets = presets.map((preset) => ({ ...preset }))
  }

  setHotwordsCache(words: string[]) {
    this.cachedHotwords = Array.from(new Set(words.map((word) => word.trim()).filter(Boolean)))
  }

  setStreamingDisplayCache(next: boolean) {
    this.cachedStreamingDisplay = next
  }

  private async applyStreamingActive(): Promise<void> {
    try {
      const [streamOn, provider] = await Promise.all([
        getSetting('streamingDisplayEnabled', false),
        getSetting('cloudAsr.provider', 'openai_compat'),
      ])
      if (this.state !== 'recording') return
      const active = Boolean(streamOn)
        && this.provider.mode === 'cloud_api'
        && isStreamingDisplayReady(String(provider || ''))
      this.overlayService.setStreamingActive(active)
    } catch {
    }
  }

  async refreshRuntimeSettings() {
    const [
      micId,
      muteSystemAudio,
      protectClipboard,
      presets,
      activePresetId,
      aiEnabled,
      aiMinDurationSec,
      contextAwareWriting,
      contextSelectionEditPrompt,
      appPromptRules,
      userStats,
      streamingDisplay,
      injectHotwords,
      noiseSuppression,
    ] = await Promise.all([
      getSetting('selectedMic', ''),
      getSetting('muteSystemAudioWhileRecording', false),
      getSetting('protectClipboard', true),
      getPromptPresets(),
      getActivePresetId(),
      getSetting('aiEnabled', false),
      getSetting('aiMinDurationSec', 0),
      getSetting('contextAwareWritingEnabled', false),
      getSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT),
      getAppPromptRules(),
      getUserStats(),
      getSetting('streamingDisplayEnabled', false),
      getSetting('injectHotwordsToPrompt', false),
      getSetting('micNoiseSuppression', true),
    ])

    this.noiseSuppression = Boolean(noiseSuppression)
    this.cachedMicId = String(micId || '')
    this.cachedMuteSystemAudio = Boolean(muteSystemAudio)
    this.cachedProtectClipboard = Boolean(protectClipboard)
    this.cachedInjectHotwords = Boolean(injectHotwords)
    this.cachedPresets = presets
    this.cachedActivePresetId = activePresetId
    this.cachedAiEnabled = Boolean(aiEnabled)
    this.cachedAiMinDurationSec = Math.max(0, Math.min(MAX_RECORDING_SEC, Number(aiMinDurationSec) || 0))
    this.cachedContextAwareWriting = Boolean(contextAwareWriting)
    this.cachedContextSelectionEditPrompt = normalizeContextSelectionEditPrompt(contextSelectionEditPrompt)
    this.cachedAppPromptRules = appPromptRules
    this.cachedUserStats = userStats
    this.cachedStreamingDisplay = Boolean(streamingDisplay)
    await this.overlayService.refreshSettings()

    const [hotwordsResult, languageResult] = await Promise.allSettled([
      Promise.all([
        getSetting(BUILTIN_SET_WORDS_KEY, {}),
        getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting(CUSTOM_THEMES_KEY, []),
        getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
      ]).then(([rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive]) => {
        const setWords = normalizeBuiltinSetWords(rawSetWords as Record<string, unknown>)
        const setActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
        const themes = normalizeCustomThemes(rawCustomThemes)
        const themeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, themes)
        return composeHotwords([], setWords, setActive, themes, themeActive)
      }),
      Promise.resolve(''),
    ])

    this.cachedHotwords = hotwordsResult.status === 'fulfilled' ? hotwordsResult.value : []
    this.cachedLanguage = languageResult.status === 'fulfilled' ? languageResult.value : ''
  }

  async ensureClientRuntimeInfo() {
    if (this.clientRuntimeInfoLoaded) return
    try {
      this.cachedClientRuntimeInfo = await bridge.getClientRuntimeInfo()
      this.clientRuntimeInfoLoaded = true
    } catch {
      this.cachedClientRuntimeInfo = null
    }
  }

  reconnectProvider() {
    if (this.state === 'idle') {
      this.provider.disconnect()
    }
    this.ensureConnection()
  }

  async refreshOverlaySettings() {
    await this.overlayService.refreshSettings()
  }

  // ── State machine ──

  private transition(to: RecorderState): boolean {
    const pair = [this.state, to] as [RecorderState, RecorderState]
    const valid = VALID_TRANSITIONS.some(([f, t]) => f === pair[0] && t === pair[1])
    if (!valid) {
      addRuntimeEvent('warn', 'recorder', `Ignored invalid state transition ${this.state} → ${to}`)
      return false
    }
    addRuntimeEvent('info', 'recorder', 'State changed', { from: this.state, to })
    this.state = to
    this.onStateChange?.(to)
    return true
  }

  private clearProcessingTimeout() {
    if (this.processingTimeoutId) {
      clearTimeout(this.processingTimeoutId)
      this.processingTimeoutId = null
    }
  }

  private clearInsertionTimeout() {
    if (this.insertionTimeoutId) {
      clearTimeout(this.insertionTimeoutId)
      this.insertionTimeoutId = null
    }
  }

  private armInsertionTimeout(runId: number, text: string) {
    this.clearInsertionTimeout()
    this.insertionTimeoutId = setTimeout(() => {
      this.insertionTimeoutId = null
      this.handleInsertionStuck(runId, text, INSERTION_TIMEOUT_MS)
    }, INSERTION_TIMEOUT_MS)
  }

  private handleInsertionStuck(runId: number, text: string, waitedMs: number) {
    if (!this.textInsertionInFlight) return
    if (!this.isRunCurrent(runId)) return
    addRuntimeEvent('error', 'recorder', 'Text insertion never finished; handing the text back to the user', {
      runId,
      waitedMs,
      textLen: text.length,
    })
    this.textInsertionInFlight = false
    this.clearInsertionTimeout()
    this.clearProcessingTimeout()
    if (text.trim()) {
      this.showFallbackAndReset(text, 'insertion_timeout', runId)
      return
    }
    this.finishRun(runId)
    this.resetToIdle()
  }

  private clearMicMutedAutoCancelTimer() {
    if (this.micMutedAutoCancelId) {
      clearTimeout(this.micMutedAutoCancelId)
      this.micMutedAutoCancelId = null
    }
  }

  private scheduleMicMutedAutoCancel(runId: number) {
    this.clearMicMutedAutoCancelTimer()
    const closeWhenReady = () => {
      this.micMutedAutoCancelId = null
      if (!this.isRunCurrent(runId) || !this.osMicMuted) return
      if (this.state === 'idle' && this.startRecordingLock) {
        this.micMutedAutoCancelId = setTimeout(closeWhenReady, 100)
        return
      }
      if (this.state !== 'recording') return
      addRuntimeEvent('info', 'recorder', 'Muted microphone warning timed out; recording will close automatically', {
        runId,
        timeoutMs: MIC_MUTED_AUTO_CANCEL_MS,
      })
      void this.cancelRecording(runId, { showCanceled: false, reason: 'mic_muted_timeout' })
    }
    this.micMutedAutoCancelId = setTimeout(closeWhenReady, MIC_MUTED_AUTO_CANCEL_MS)
  }

  private async checkConfiguredMicMuted(runId: number) {
    const probeSequence = ++this.micMuteProbeSequence
    if (!this.cachedMicId || this.cachedMicId === 'default') {
      await this.checkMicMuted(null, runId, probeSequence)
      return
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (probeSequence !== this.micMuteProbeSequence || !this.isRunCurrent(runId)) return
      const inputs = devices.filter((device) => device.kind === 'audioinput')
      const selected = inputs.find((device) => device.deviceId === this.cachedMicId)

      const label = selected?.label?.trim() || ''
      if (!label) return
      await this.checkMicMuted(label, runId, probeSequence)
    } catch {
    }
  }

  private getLiveElapsedSec() {
    if (this.state === 'recording' && this.recordStartPerf > 0) {
      return elapsedSecFromPerf(this.recordStartPerf)
    }
    return this.getAudioDurationSec()
  }

  private getAudioDurationSec() {
    return this.audioSentSamples > 0 ? this.audioSentSamples / 16000 : 0
  }

  private resetToIdle(options?: ResetToIdleOptions) {
    addRuntimeEvent('info', 'recorder', 'Reset to idle', {
      fromState: this.state,
      keepOverlay: Boolean(options?.keepOverlay),
      handsFreeMode: this.handsFreeMode,
      textInsertionInFlight: this.textInsertionInFlight,
    })
    this.clearProcessingTimeout()
    this.clearInsertionTimeout()
    this.clearMicMutedAutoCancelTimer()
    this.micMuteProbeSequence++
    if (this.handsFreeAutoStopId) {
      clearTimeout(this.handsFreeAutoStopId)
      this.handsFreeAutoStopId = null
    }
    this.overlayService.stopListeningTicker()
    this.overlayService.resetWarnings()
    this.overlayService.resetStreamingText()
    this.restoreSystemMuteIfNeeded()
    this.startRecordingLock = false
    this.pendingStopWhileStarting = false
    this.handsFreeMode = false
    this.finalHandledInCurrentRun = false
    this.textInsertionInFlight = false
    this.processingCancelable = false
    this.captureReadyPromise = null
    this.finalReceivedAt = 0
    this.pendingHistoryArtifact = null
    this.currentActiveAppContext = null
    this.currentPromptResolution = null
    this.cachedProbeResult = null
    this.consecutiveSilentSamples = 0
    this.consecutiveNonVoicedSamples = 0
    this.quietRunSawSignal = false
    this.consecutiveVoicedSamples = 0
    this.currentVolumeWarning = 'none'
    this.hasDetectedVoiceThisSession = false
    this.lastLowVolumeWarnAt = 0
    this.osMicMuted = false
    this.pendingOsMicMuted = false
    this.pendingOsMicMutedSamples = 0
    clearCapturedInsertionTarget()
    this.recordStartPerf = 0
    if (!options?.preserveLateFinalContext) {
      this.timedOutProcessingContext = null
    }
    this.transition('idle')
    if (!options?.keepOverlay) {
      this.overlayService.clearFallbackHideTimer()
      this.overlayService.hide()
    }
  }

  private async discardCanceledHistory(artifact: { recordId: string; audioFilePath?: string }) {
    try {
      if (artifact.audioFilePath) await bridge.deleteAudioFile(artifact.audioFilePath)
    } catch {  }
    try {
      await deleteHistory(artifact.recordId)
      void bridge.emit('history-updated')
    } catch {  }
  }

  private async cancelRecording(
    token: number,
    options: { showCanceled?: boolean; reason?: 'user' | 'mic_muted_timeout' } = {},
  ) {
    const showCanceled = options.showCanceled ?? true
    const reason = options.reason ?? 'user'
    if (
      this.state !== 'recording'
      || token === 0
      || token !== this.activeRunId
    ) {
      addRuntimeEvent('info', 'recorder', 'Ignored recording cancellation', {
        state: this.state,
        token,
        activeRunId: this.activeRunId,
        reason,
      })
      return
    }

    const canceledRunId = this.activeRunId
    if (!this.transition('processing')) return
    this.markRunCanceled(canceledRunId)
    this.finalHandledInCurrentRun = true
    this.processingCancelable = false
    this.overlayService.stopListeningTicker()
    this.restoreSystemMuteIfNeeded()
    this.recordedChunks = []
    this.finishRun(canceledRunId)
    this.provider.cancel()

    addRuntimeEvent('info', 'recorder', 'Recording canceled', {
      runId: canceledRunId,
      mode: this.provider.mode,
      reason,
    })
    if (showCanceled) this.overlayService.showCanceled()

    try {
      await stopCapture()
    } catch (error) {
      addRuntimeEvent('warn', 'recorder', 'Failed to stop capture while canceling', { error: String(error) })
    } finally {
      if (this.getState() === 'processing' && this.activeRunId === 0) {
        this.resetToIdle({ keepOverlay: showCanceled })
      }

    }
  }

  private cancelProcessing(token: number) {
    if (
      this.state !== 'processing'
      || token === 0
      || token !== this.activeRunId
      || !this.processingCancelable
    ) {
      addRuntimeEvent('info', 'recorder', 'Ignored Esc processing cancellation', {
        state: this.state,
        token,
        activeRunId: this.activeRunId,
        processingCancelable: this.processingCancelable,
      })
      return
    }

    const canceledRunId = this.activeRunId
    const historyArtifact = this.pendingHistoryArtifact
    this.clearProcessingTimeout()
    this.markRunCanceled(canceledRunId)
    this.discardAudioArchive(canceledRunId)
    if (this.timedOutProcessingContext?.runId === canceledRunId) {
      this.timedOutProcessingContext.settled = true
    }
    this.timedOutProcessingContext = null
    this.processingCancelable = false
    this.provider.cancel()
    this.recordedChunks = []
    this.finishRun(canceledRunId)
    if (historyArtifact?.runId === canceledRunId) {
      void this.discardCanceledHistory(historyArtifact)
    }

    addRuntimeEvent('info', 'recorder', 'Processing canceled by user', {
      runId: canceledRunId,
      mode: this.provider.mode,
    })
    this.overlayService.showCanceled()
    this.resetToIdle({ keepOverlay: true })


  }

  // ── Provider callbacks ──

  private buildProviderCallbacks(): TranscriptionCallbacks {
    return {
      onPartialASR: (text) => {
        if (this.state !== 'recording') return
        this.overlayService.setStreamingText(text)
      },

      onASR: (result) => {
        if (this.state !== 'processing') return
        if (this.finalHandledInCurrentRun) return
        if (result.text && result.text.trim() !== '') return

        const runId = this.activeRunId
        if (!this.isRunCurrent(runId)) return
        this.finalHandledInCurrentRun = true
        this.clearProcessingTimeout()

        const audioDur = this.getAudioDurationSec()
        const wallSec = this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : audioDur
        const audioChunkCount = this.recordedChunks.length
        const historyMeta = this.buildHistoryMetadata(
          this.currentPromptResolution,
          this.currentActiveAppContext,
        )
        const silenceProven = this.hasSilenceEvidence()
        const silenceDiagnostic = {
          reason: 'asr_empty',
          mode: this.provider.mode,
          audioSec: Number(audioDur.toFixed(1)),
          asrMs: result.asrMs || 0,
          audioChunks: audioChunkCount,
          silenceProven,
          peakAmplitude: Math.round(this.audioStatsPeakAmplitude * 10000) / 10000,
          runId,
        }
        //
        this.overlayService.showNoSpeech(silenceProven ? 'silent' : 'no_text', silenceDiagnostic)
        if (!silenceProven) {
          addRuntimeEvent('warn', 'recorder', 'ASR returned no text and there is no silence evidence', silenceDiagnostic)
        }
        void (async () => {
          await this.archiveFailedRun({
            runId,
            audioDurationSec: audioDur,
            wallTimeSec: wallSec,
            asrMs: result.asrMs || 0,
            asrDurationSec: result.durationSec > 0 ? result.durationSec : undefined,
            failReason: t('recorder.noTranscript'),
            failReasonCode: 'no_transcript',
            historyMeta,
            aiSource: result.aiSource,
            aiStatus: result.aiStatus,
          })

          if (!this.isRunCurrent(runId)) return
          this.finishRun(runId)
          this.resetToIdle({ keepOverlay: true })
        })()
      },

      onFinal: (result) => {
        if (this.state !== 'processing') {
          const lateContext = this.consumeTimedOutProcessingContext()
          if (!lateContext) return

          addRuntimeEvent('warn', 'recorder', 'Received a late final result for a timed-out session', {
            timedOutAt: lateContext.timedOutAt,
            lateByMs: Date.now() - lateContext.timedOutAt,
            durationSec: result.durationSec,
            asrMs: result.asrMs,
            llmMs: result.llmMs,
          })
          this.provider.cancel()

          this.finalizingLateRunId = lateContext.runId
          const abandoned = this.lateResultAbandoned
          if (abandoned) {
            addRuntimeEvent('warn', 'recorder', 'Late final arrived after the user abandoned it; saving without inserting', {
              runId: lateContext.runId,
              lateByMs: Date.now() - lateContext.timedOutAt,
            })
          }
          void this.processFinalResult(result, lateContext, {
            allowInsertionWhenIdle: true,
            source: 'late_after_timeout',
          }).finally(() => {
            if (this.finalizingLateRunId === lateContext.runId) this.finalizingLateRunId = 0
            if (this.lateResultRunId === lateContext.runId) {
              this.lateResultRunId = 0
              this.lateResultAbandoned = false
            }
          })
          return
        }
        if (this.finalHandledInCurrentRun) {
          addRuntimeEvent('warn', 'recorder', 'Ignored duplicate final result')
          return
        }
        this.finalHandledInCurrentRun = true
        this.clearProcessingTimeout()
        this.finalReceivedAt = Date.now()

        const localAudioDur = this.getAudioDurationSec()
        console.log('[ptt-diag] onFinal', {
          backendDurationSec: result.durationSec,
          localAudioDurSec: localAudioDur.toFixed(2),
          audioSentSamples: this.audioSentSamples,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
        })

        void this.processFinalResult(result, {
          runId: this.activeRunId,
          timedOutAt: 0,
          settled: true,
          audioDurationSec: this.getAudioDurationSec(),
          wallTimeSec: this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : this.getAudioDurationSec(),
          promptResolution: this.currentPromptResolution ? { ...this.currentPromptResolution } : null,
          appContext: this.currentActiveAppContext ? { ...this.currentActiveAppContext } : null,
          audioChunks: this.recordedChunks.slice(),
          probeResult: this.cachedProbeResult ? { ...this.cachedProbeResult } : null,
        }, {
          allowInsertionWhenIdle: false,
          source: 'processing',
        })
      },

      onDone: () => {
        if (this.state !== 'processing') return
        if (this.finalHandledInCurrentRun) return
        if (this.textInsertionInFlight) return
        const runId = this.activeRunId
        this.clearProcessingTimeout()

        if (this.audioArchives.has(runId)) {
          const audioDur = this.getAudioDurationSec()
          const wallSec = this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : audioDur
          const historyMeta = this.buildHistoryMetadata(
            this.currentPromptResolution,
            this.currentActiveAppContext,
          )
          addRuntimeEvent('warn', 'recorder', 'Provider finished without any result; saving audio to history', {
            runId,
            mode: this.provider.mode,
            audioSec: audioDur,
          })
          void (async () => {
            await this.failRunWithCard(runId, {
              title: t('recorder.protocolIncompleteTitle'),
              detail: t('recorder.protocolIncompleteDetail'),
              audioDurationSec: audioDur,
              wallTimeSec: wallSec,
              failReason: t('record.providerFailed'),
              failReasonCode: 'provider_failed',
              historyMeta,
            })
            this.finishRun(runId)
          })()
          this.resetToIdle({ keepOverlay: true })
          return
        }

        this.finishRun(runId)
        this.resetToIdle()
      },

      onError: (msg) => {
        const runId = this.activeRunId
        if (!this.isRunCurrent(runId) || (this.state !== 'recording' && this.state !== 'processing')) {
          addRuntimeEvent('warn', 'backend', 'Ignored error callback from a stale session', { msg, state: this.state, runId })
          return
        }
        const friendlyFailure = describeProviderError(msg)
        addRuntimeEvent('error', 'backend', msg)
        this.clearProcessingTimeout()
        this.processingCancelable = false
        void this.overlayService.disableEscapeAction()
        this.finalHandledInCurrentRun = true

        const failedWhileRecording = this.state === 'recording'
        if (failedWhileRecording) {
          this.overlayService.stopListeningTicker()
          void stopCapture().catch(() => { })
          this.restoreSystemMuteIfNeeded()
          this.transition('processing')
        }

        const audioDur = this.getAudioDurationSec()
        const wallSec = this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : audioDur
        const historyMeta = this.buildHistoryMetadata(
          this.currentPromptResolution,
          this.currentActiveAppContext,
        )
        if (audioDur >= 0.5 && this.recordedChunks.length > 0) {
          this.ensureAudioArchive(runId, this.recordedChunks.slice())
        }
        void (async () => {
          if (audioDur >= 0.5) {
            //
            await this.failRunWithCard(runId, {
              title: t('recorder.recognitionFailedTitle'),
              detail: friendlyFailure.message,
              audioDurationSec: audioDur,
              wallTimeSec: wallSec,
              failReason: friendlyFailure.detail,
              failReasonCode: classifyHistoryProviderFailure(msg),
              historyMeta,
            })
          } else if (this.isRunCurrent(runId)) {
            this.overlayService.showError(friendlyFailure.message)
          }

          if (!this.isRunCurrent(runId)) return
          this.finishRun(runId)
          this.resetToIdle({ keepOverlay: true })
        })()
      },
    }
  }

  // ── Text insertion: uses pre-probed editable result ──

  private async handleTextInsertion(
    text: string,
    options: { allowWhenIdle?: boolean; runId: number; probeResult?: ProbeResult | null },
  ) {
    const insertionStartedAt = Date.now()
    const { runId } = options
    const allowWhenIdle = options.allowWhenIdle === true
    if (!this.isRunCurrent(runId)) return

    // Guard: if we're no longer in processing (e.g. timeout fired), bail out unless this
    // is the explicitly retained late-final path.
    if (this.state !== 'processing' && !allowWhenIdle) {
      addRuntimeEvent('warn', 'recorder', 'Skipped text insertion because state is no longer processing', { state: this.state, runId })
      return
    }

    //
    if (runId === this.lateResultRunId && this.lateResultAbandoned) {
      addRuntimeEvent('warn', 'recorder', 'Skipped text insertion because the user abandoned this late result', {
        runId,
        textLen: text.length,
      })
      this.overlayService.hide()
      return
    }

    // Cancel the processing timeout — we're handling the result now.
    if (this.state === 'processing') {
      this.clearProcessingTimeout()
    }

    const capturedProbe = options.probeResult ?? null
    const probe = capturedProbe ?? await this.pasteService.getProbeResult()
    if (!this.isRunCurrent(runId)) return

    const usedCapturedProbe = capturedProbe !== null
    const probeAgeMs = typeof probe.completedAt === 'number' ? Date.now() - probe.completedAt : undefined
    const probeDurationMs = (
      typeof probe.completedAt === 'number'
      && typeof probe.startedAt === 'number'
    )
      ? probe.completedAt - probe.startedAt
      : undefined
    addRuntimeEvent('info', 'recorder', 'Paste decision', {
      runId,
      probeId: probe.probeId,
      editable: probe.editable,
      gate: probe.gate,
      hwnd: probe.hwnd,
      focusHwnd: probe.focusHwnd,
      pid: probe.pid,
      process: probe.process,
      verdict: probe.verdict,
      isCurrentAppProcess: probe.isCurrentAppProcess,
      windowClass: probe.windowClass,
      focusClass: probe.focusClass,
      usedCapturedProbe,
      probeAgeMs,
      probeDurationMs,
      finalToDecisionMs: this.finalReceivedAt > 0 ? insertionStartedAt - this.finalReceivedAt : undefined,
      detail: probe.detail,
      textLen: text.length,
    })

    if (probe.isCurrentAppProcess) {
      addRuntimeEvent('info', 'recorder', 'Target is SayIt; using native paste instead of renderer insertion', {
        probeId: probe.probeId,
        editable: probe.editable,
        hwnd: probe.hwnd,
        focusHwnd: probe.focusHwnd,
      })
    }

    if (!probe.editable) {
      addRuntimeEvent('info', 'recorder', 'Target is not editable; showing fallback card', {
        probeId: probe.probeId,
        pid: probe.pid,
        process: probe.process,
        verdict: probe.verdict,
        gate: probe.gate,
        isCurrentAppProcess: probe.isCurrentAppProcess,
        detail: probe.detail,
      })
      if (!this.isRunCurrent(runId)) return
      this.showFallbackAndReset(text, 'not_editable', runId)
      return
    }

    await this.waitForModifierPTTReleaseIfNeeded()
    if (!this.isRunCurrent(runId)) return

    this.processingCancelable = false
    await this.overlayService.disableEscapeAction()
    if (!this.isRunCurrent(runId)) return

    // Target was editable → paste (pass the captured probe so Rust uses the original hwnd)
    const pasteStartedAt = Date.now()
    const result = await this.pasteService.pasteText(text, probe, this.cachedProtectClipboard)
    if (!this.isRunCurrent(runId)) return
    const pasteExecMs = Date.now() - pasteStartedAt

    if (result.ok && isUnconfirmedPaste(result.strategy, pasteExecMs)) {
      addRuntimeEvent('warn', 'recorder', 'External text insertion unconfirmed; showing fallback card', {
        strategy: result.strategy,
        gate: probe.gate,
        detail: result.detail,
        finalToPasteDoneMs: this.finalReceivedAt > 0 ? Date.now() - this.finalReceivedAt : undefined,
        pasteExecMs,
      })
      this.showFallbackAndReset(text, 'paste_unconfirmed', runId)
      return
    }

    if (result.ok) {
      addRuntimeEvent('info', 'recorder', 'External text insertion succeeded', {
        strategy: result.strategy,
        gate: probe.gate,
        detail: result.detail,
        attempts: result.attempts,
        finalToPasteDoneMs: this.finalReceivedAt > 0 ? Date.now() - this.finalReceivedAt : undefined,
        pasteExecMs,
      })

      this.finishRun(runId)
      if (this.state === 'processing') {
        this.resetToIdle()
      } else {
        this.overlayService.hide()
      }
      return
    }

    // Paste command failed (SendInput error, timeout, etc.). The card now lets the user
    // explicitly copy or dismiss; do not overwrite the clipboard automatically here.
    const level = result.reason === 'paste_exception' ? 'error' : 'warn'
    addRuntimeEvent(level, 'recorder', 'External text insertion failed; showing fallback card', {
      strategy: result.strategy,
      reason: result.reason,
      gate: probe.gate,
      detail: result.detail,
      attempts: result.attempts,
      finalToPasteDoneMs: this.finalReceivedAt > 0 ? Date.now() - this.finalReceivedAt : undefined,
      pasteExecMs: Date.now() - pasteStartedAt,
    })
    this.showFallbackAndReset(text, result.reason || 'paste_failed', runId)
  }

  /**
   * Show fallback card and transition to idle.
   * Ensures overlay layout is switched to fallback BEFORE hiding other states.
   */
  private showFallbackAndReset(text: string, reason: string, runId: number) {
    if (!this.isRunCurrent(runId)) return
    addRuntimeEvent('info', 'recorder', 'Showing fallback card', {
      runId,
      reason,
      textLen: text.length,
      stateBeforeReset: this.state,
    })
    this.activeFallbackToken = runId
    this.overlayService.showFallback(text, reason, runId)
    this.finishRun(runId)
    // Then: transition to idle but keep overlay visible
    if (this.state === 'processing') {
      this.resetToIdle({ keepOverlay: true })
    }
  }

  // ── Connection management ──

  private ensureConnection() {
    if (this.provider.isReady()) return
    this.provider.connect(this.buildProviderCallbacks()).catch((err) => {
      addRuntimeEvent('warn', 'transcription', 'Provider initialization failed; retrying in 5s', { error: String(err) })
      setTimeout(() => this.ensureConnection(), 5000)
    })
  }

  // ── Recording lifecycle ──

  private async startRecording() {
    if (
      this.state !== 'idle'
      || this.startRecordingLock
      || this.textInsertionInFlight
      || this.finalizingLateRunId !== 0
    ) {
      addRuntimeEvent('info', 'recorder', 'Ignored start-recording request', {
        state: this.state,
        locked: this.startRecordingLock,
        textInsertionInFlight: this.textInsertionInFlight,
        finalizingLateRunId: this.finalizingLateRunId,
      })
      return
    }

    if (!this.provider.isReady()) {
      this.handsFreeMode = false
      addRuntimeEvent('warn', 'recorder', 'Provider not ready; ignored start-recording request', { mode: this.provider.mode })
      this.overlayService.showError(this.notReadyMessage())
      this.ensureConnection()
      return
    }

    const timedOutContext = this.timedOutProcessingContext
    if (timedOutContext) {
      this.timedOutProcessingContext = null
      this.provider.cancel()
      this.finishRun(timedOutContext.runId)
    }

    const runId = ++this.runSequence
    this.activeRunId = runId
    this.activeFallbackToken = 0
    this.startRecordingLock = true
    this.pendingStopWhileStarting = false
    this.timedOutProcessingContext = null
    this.clearMicMutedAutoCancelTimer()
    this.osMicMuted = false
    this.pendingOsMicMuted = false
    this.pendingOsMicMutedSamples = 0

    this.overlayService.showWaiting()
    void this.checkConfiguredMicMuted(runId)

    const targetCapture = captureActiveInsertionTarget(undefined, {
      preserveExistingOnFailure: true,
    })
    let activeAppContext: ActiveAppContext | null = null
    try {
      // AI is the only consumer of editor text. If cleanup is off, do not read the text even when
      // the preference remains enabled, so the privacy boundary matches actual behavior.
      const includeTextContext = this.cachedContextAwareWriting && this.cachedAiEnabled
      const recordingContext = await bridge.getRecordingContext(includeTextContext)
      activeAppContext = recordingContext.appContext as unknown as ActiveAppContext
      this.cachedProbeResult = recordingContext.probe as unknown as ProbeResult
      addRuntimeEvent('info', 'recorder', 'Insertion probe cached at recording start', {
        probeId: this.cachedProbeResult.probeId,
        hwnd: this.cachedProbeResult.hwnd,
        focusHwnd: this.cachedProbeResult.focusHwnd,
        editable: this.cachedProbeResult.editable,
        process: this.cachedProbeResult.process,
        verdict: this.cachedProbeResult.verdict,
      })
    } catch {
      activeAppContext = null
      this.cachedProbeResult = null
    }
    const textContext = usableTextContext(activeAppContext?.textContext)
    if (activeAppContext) {
      if (textContext) activeAppContext.textContext = textContext
      else delete activeAppContext.textContext
    }
    this.currentActiveAppContext = activeAppContext

    this.currentPromptResolution = resolvePromptRouting({
      appContext: activeAppContext,
      presets: this.cachedPresets,
      activePresetId: this.cachedActivePresetId,
      appRules: this.cachedAppPromptRules,
      userStats: this.cachedUserStats,
      hotwords: this.cachedHotwords,
      injectHotwords: this.cachedInjectHotwords,
    })
    if (textContext) {
      this.currentPromptResolution = {
        ...this.currentPromptResolution,
        systemPrompt: withContextAwareInstructions(
          this.currentPromptResolution.systemPrompt,
          textContext,
          this.cachedContextSelectionEditPrompt,
        ),
        summary: `${this.currentPromptResolution.summary} | Text context: ${textContext.selectedText ? 'selection' : 'caret'}`,
      }
      addRuntimeEvent('info', 'recorder', 'Text context captured', {
        source: textContext.source,
        beforeLen: textContext.textBefore.length,
        selectedLen: textContext.selectedText.length,
        afterLen: textContext.textAfter.length,
      })
    }

    addRuntimeEvent('info', 'recorder', 'Recording started', {
      micId: this.cachedMicId || 'default',
      preset: this.currentPromptResolution.preset.id || this.currentPromptResolution.preset.name || 'none',
      targetCapture,
      appContext: this.summarizeAppContext(activeAppContext || null),
      promptRouting: {
        appId: this.currentPromptResolution.appId,
        appName: this.currentPromptResolution.appName,
        presetId: this.currentPromptResolution.preset.id,
        presetName: this.currentPromptResolution.preset.name,
        promptRuleId: this.currentPromptResolution.matchedRule?.id,
        summary: this.currentPromptResolution.summary,
      },
    })
    addRuntimeEvent('info', 'personalization', 'Prompt routing resolved', {
      appContext: this.summarizeAppContext(activeAppContext || null),
      appId: this.currentPromptResolution.appId,
      appName: this.currentPromptResolution.appName,
      presetId: this.currentPromptResolution.preset.id,
      presetName: this.currentPromptResolution.preset.name,
      promptRuleId: this.currentPromptResolution.matchedRule?.id,
      summary: this.currentPromptResolution.summary,
    })

    this.finalHandledInCurrentRun = false
    this.lateResultAbandoned = false
    this.lateResultRunId = 0
    this.audioSentSamples = 0
    this.wallTimeAtStopSec = 0
    this.recordedChunks = []
    // Reset audio stats
    this.audioStatsRmsSum = 0
    this.audioStatsPeakRms = 0
    this.audioStatsPeakAmplitude = 0
    this.audioStatsSilentFrames = 0
    this.audioStatsTotalFrames = 0
    this.consecutiveSilentSamples = 0
    this.consecutiveNonVoicedSamples = 0
    this.quietRunSawSignal = false
    this.consecutiveVoicedSamples = 0
    this.currentVolumeWarning = 'none'
    this.hasDetectedVoiceThisSession = false
    this.lastLowVolumeWarnAt = 0
    resetWaveformBarState(this.overlayWaveState, this.overlayService.getBarCount(), 3)

    // Hands-free mode: arm a 5-minute auto-stop timer
    // is handled by the Rust keyboard hook's hard_timeout_release)
    const armHandsFreeTimer = () => {
      if (!this.handsFreeMode) return
      this.handsFreeAutoStopId = setTimeout(() => {
        if (this.state === 'recording' && this.handsFreeMode) {
          addRuntimeEvent('warn', 'recorder', 'Hands-free recording is approaching the five-minute limit')
          this.overlayService.showTimeoutWarning()
          // Auto-stop after 1 more minute
          this.handsFreeAutoStopId = setTimeout(() => {
            if (this.state === 'recording' && this.handsFreeMode) {
              addRuntimeEvent('warn', 'recorder', 'Hands-free recording reached five minutes and stopped automatically')
              void this.stopRecording()
            }
          }, RECORDING_COUNTDOWN_SEC * 1000)
        }
      }, (MAX_RECORDING_SEC - RECORDING_COUNTDOWN_SEC) * 1000)
    }

    this.currentAiConfig = {
      workMode: this.provider.mode,
      aiEnabled: this.cachedAiEnabled,
      aiMinDurationSec: this.cachedAiMinDurationSec,
    }
    this.currentOperationId = `${runId}-${Date.now().toString(36)}`

    const promptOpts = this.currentPromptResolution
      ? {
        runId,
        operationId: this.currentOperationId,
        aiConfig: this.currentAiConfig,
        systemPrompt: this.cachedAiEnabled ? this.currentPromptResolution.systemPrompt : undefined,
        disableAi: !this.cachedAiEnabled,
        aiMinDurationSec: this.cachedAiMinDurationSec,
        clientMeta: this.cachedClientRuntimeInfo,
        appContext: activeAppContext,
        textContext,
        hotwords: this.cachedHotwords.length > 0 ? this.cachedHotwords : undefined,
        language: this.cachedLanguage || undefined,
        streamingDisplay: this.cachedStreamingDisplay,
      }
      : {
        runId,
        operationId: this.currentOperationId,
        aiConfig: this.currentAiConfig,
        disableAi: !this.cachedAiEnabled,
        aiMinDurationSec: this.cachedAiMinDurationSec,
        clientMeta: this.cachedClientRuntimeInfo,
        appContext: activeAppContext,
        textContext,
        hotwords: this.cachedHotwords.length > 0 ? this.cachedHotwords : undefined,
        language: this.cachedLanguage || undefined,
        streamingDisplay: this.cachedStreamingDisplay,
      }

    // Wrap the async setup so stopRecording can wait for it
    let resolveCaptureReady: () => void
    this.captureReadyPromise = new Promise<void>((resolve) => { resolveCaptureReady = resolve })

    try {

      const [, captureResult] = await Promise.all([
        this.provider.connect(this.buildProviderCallbacks()),
        startCapture(
          this.cachedMicId || undefined,
          (buffer) => {
            if (!this.isRunCurrent(runId)) return
            if (this.audioSentSamples === 0) {
              console.log('[ptt-diag] first onData buffer', {
                byteLength: buffer.byteLength,
                samples: buffer.byteLength / 2,
              })
            }
            this.recordedChunks.push(buffer.slice(0))
            this.provider.sendAudio(buffer)
          },
          undefined,
          (pcmFrame) => {
            if (!this.isRunCurrent(runId)) return
            this.audioSentSamples += pcmFrame.length
            const bars = computeBarsFromPCM(pcmFrame, this.overlayWaveState, {
              barCount: this.overlayService.getBarCount(),
              minHeight: 3,
              maxHeight: 18,
            })
            this.overlayService.pushListeningBars(bars)

            let sum = 0
            let framePeakRaw = 0
            for (let i = 0; i < pcmFrame.length; i++) {
              const s = pcmFrame[i]
              sum += s * s
              const amp = s < 0 ? -s : s
              if (amp > framePeakRaw) framePeakRaw = amp
            }
            const rms = Math.sqrt(sum / pcmFrame.length) / 32768
            const framePeak = framePeakRaw / 32768

            // Audio stats tracking
            this.audioStatsTotalFrames++
            this.audioStatsRmsSum += rms
            if (rms > this.audioStatsPeakRms) this.audioStatsPeakRms = rms
            if (framePeak > this.audioStatsPeakAmplitude) this.audioStatsPeakAmplitude = framePeak
            if (rms < RecorderOrchestrator.SILENCE_RMS_THRESHOLD) this.audioStatsSilentFrames++

            this.updateVolumeWarning(classifyMicLevel(rms, framePeak), pcmFrame.length)
          },
          this.noiseSuppression,
        ),
      ])
      resolveCaptureReady!()
      if (!this.isRunCurrent(runId)) {
        await stopCapture().catch(() => { })
        return
      }

      // Both WebSocket and mic are ready — send start command
      const started = this.provider.start(promptOpts)
      if (!started) {
        throw new Error('sendStart failed')
      }
      addRuntimeEvent('info', 'recorder', 'Start sent; audio capture beginning')

      // Audio capture is now active — transition to recording state and show audio bars
      this.recordStartPerf = performance.now()
      if (!this.transition('recording')) {
        this.startRecordingLock = false
        this.provider.cancel()
        this.finishRun(runId)
        this.resetToIdle()

        return
      }
      this.startRecordingLock = false
      void this.applyStreamingActive()
      this.overlayService.startListeningTicker(runId)
      const micSource = describeMicSource(
        captureResult,
        this.cachedMicId,
        t('mic.title'),
        captureResult.devices,
      )
      if (micSourceChanged(this.lastMicSourceIdentity, micSource.identity)) {
        this.lastMicSourceIdentity = micSource.identity
        this.overlayService.showMicSourceHint({ mode: micSource.mode, label: micSource.label })
        addRuntimeEvent('info', 'recorder', 'Input source reminder shown', {
          mode: micSource.mode,
          label: micSource.label,
          rawLabel: captureResult.label,
          endpointCount: captureResult.devices.length,
        })
      }
      void this.checkMicMuted(
        captureResult.label || null,
        runId,
        ++this.micMuteProbeSequence,
      )
      this.scheduleSystemMuteIfEnabled()
      armHandsFreeTimer()

      // Check if PTT up arrived while we were initializing
      if (this.pendingStopWhileStarting) {
        this.pendingStopWhileStarting = false
        addRuntimeEvent('info', 'recorder', 'PTT released during initialization; stopping immediately')
        void this.stopRecording()
        return
      }

    } catch (error) {
      resolveCaptureReady!()
      this.startRecordingLock = false
      this.pendingStopWhileStarting = false
      this.restoreSystemMuteIfNeeded()
      addRuntimeEvent('error', 'recorder', 'Failed to start recording', { error: String(error) })
      try { await stopCapture() } catch { /* ignore */ }
      this.finishRun(runId)
      this.provider.cancel()
      const errMsg = String(error)
      if (errMsg.includes('microphone') || errMsg.includes('audio')) {
        this.overlayService.showError(t('recorder.microphoneUnavailable'))
      } else {
        this.overlayService.showError(t('recorder.startFailed'))
      }
      this.resetToIdle({ keepOverlay: true })
    }
  }

  private updateVolumeWarning(level: MicLevel, sampleCount: number) {
    const REWARN_MS = 5000
    const CLEAR_VOICED = 8000
    const VOICED_GAP_TOLERANCE = 4800
    const firstWarn = this.hasDetectedVoiceThisSession ? 80000 : 32000 // 5s / 2s @16kHz

    if (this.pendingOsMicMuted) {
      const decision = judgeOsMicMute(this.pendingOsMicMutedSamples, level, sampleCount)
      if (decision.verdict === 'confirmed') {
        this.pendingOsMicMuted = false
        this.pendingOsMicMutedSamples = 0
        this.osMicMuted = true
        addRuntimeEvent('warn', 'recorder', 'Microphone is muted by the operating system (confirmed: audio is all-zero)')
        this.overlayService.showMicMutedAlert()
        this.scheduleMicMutedAutoCancel(this.activeRunId)
      } else if (decision.verdict === 'dismissed') {
        this.pendingOsMicMuted = false
        this.pendingOsMicMutedSamples = 0
        addRuntimeEvent('info', 'recorder', 'System reported the microphone as muted but audio is flowing; ignoring the flag')
      } else {
        this.pendingOsMicMutedSamples = decision.silentSamples
      }
    }

    if (this.osMicMuted) {
      if (level === 'voiced') {
        this.consecutiveVoicedSamples += sampleCount
        this.consecutiveNonVoicedSamples = 0
        if (this.consecutiveVoicedSamples < CLEAR_VOICED) return
      } else {
        this.consecutiveNonVoicedSamples += sampleCount
        if (this.consecutiveNonVoicedSamples >= VOICED_GAP_TOLERANCE) this.consecutiveVoicedSamples = 0
        return
      }
      this.osMicMuted = false
      this.clearMicMutedAutoCancelTimer()
      this.overlayService.clearWarning()
      this.currentVolumeWarning = 'none'
      this.consecutiveVoicedSamples = 0
      this.consecutiveSilentSamples = 0
      this.consecutiveNonVoicedSamples = 0
      this.quietRunSawSignal = false
      this.hasDetectedVoiceThisSession = true
      return
    }

    if (level === 'voiced') {
      this.quietRunSawSignal = true
      this.consecutiveVoicedSamples += sampleCount
      this.consecutiveNonVoicedSamples = 0
      if (this.consecutiveVoicedSamples >= CLEAR_VOICED) {
        this.hasDetectedVoiceThisSession = true
        this.consecutiveSilentSamples = 0
        this.quietRunSawSignal = false
        if (this.currentVolumeWarning !== 'none') {
          this.overlayService.clearWarning()
          this.currentVolumeWarning = 'none'
        }
      }
      return
    }

    this.consecutiveSilentSamples += sampleCount
    this.consecutiveNonVoicedSamples += sampleCount
    if (level === 'low') this.quietRunSawSignal = true
    if (this.consecutiveNonVoicedSamples >= VOICED_GAP_TOLERANCE) this.consecutiveVoicedSamples = 0

    if (this.consecutiveSilentSamples < firstWarn) return

    const kind: 'muted' | 'low' =
      !this.hasDetectedVoiceThisSession && !this.quietRunSawSignal ? 'muted' : 'low'

    const now = Date.now()
    if (kind === this.currentVolumeWarning && now - this.lastLowVolumeWarnAt < REWARN_MS) return
    this.lastLowVolumeWarnAt = now
    this.currentVolumeWarning = kind
    if (kind === 'muted') {
      addRuntimeEvent('warn', 'recorder', 'No microphone signal detected; device may be wrong or unavailable')
      this.overlayService.showNoSignalWarning()
    } else {
      addRuntimeEvent('warn', 'recorder', 'Microphone volume is low')
      this.overlayService.showLowVolumeWarning()
    }
  }

  private async checkMicMuted(
    activeDeviceLabel: string | null,
    runId: number,
    probeSequence: number,
  ) {
    try {
      const res = await invoke<{ matched: boolean; muted: boolean }>('get_mic_mute_state', {
        deviceLabel: activeDeviceLabel,
      })
      if (probeSequence !== this.micMuteProbeSequence || !this.isRunCurrent(runId)) return
      if (this.state !== 'recording' && !(this.state === 'idle' && this.startRecordingLock)) return
      if (this.hasDetectedVoiceThisSession || !res.matched) return

      if (res.muted) {
        if (this.osMicMuted || this.pendingOsMicMuted) return
        this.pendingOsMicMuted = true
        this.pendingOsMicMutedSamples = 0
        addRuntimeEvent('info', 'recorder', 'System reports the microphone endpoint is muted; waiting for audio to confirm')
      } else {
        this.pendingOsMicMuted = false
        this.pendingOsMicMutedSamples = 0
        if (this.osMicMuted) {
          this.osMicMuted = false
          this.clearMicMutedAutoCancelTimer()
          this.overlayService.clearWarning()
        }
      }
    } catch {  }
  }

  private async stopRecording() {
    if (this.state !== 'recording') {
      addRuntimeEvent('info', 'recorder', 'Ignored stop-recording request', { state: this.state })
      return
    }

    const runId = this.activeRunId
    this.clearMicMutedAutoCancelTimer()

    // Wait for capture setup to complete (getUserMedia + AudioWorklet can take time)
    if (this.captureReadyPromise) {
      try {
        await Promise.race([
          this.captureReadyPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)), // 3s max wait
        ])
      } catch { /* ignore */ }
      this.captureReadyPromise = null
    }
    if (this.state !== 'recording' || !this.isRunCurrent(runId)) return

    this.overlayService.stopListeningTicker()
    addRuntimeEvent('info', 'recorder', 'Recording stopped')

    try { await stopCapture() } catch (error) {
      addRuntimeEvent('error', 'recorder', 'Failed to stop audio capture', { error: String(error) })
    }
    if (this.state !== 'recording' || !this.isRunCurrent(runId)) return

    this.restoreSystemMuteIfNeeded()

    const audioDur = this.getAudioDurationSec()
    const pttHoldMs = elapsedSecFromPerf(this.recordStartPerf) * 1000
    const wallTimeSec = pttHoldMs / 1000
    this.wallTimeAtStopSec = wallTimeSec
    console.log('[ptt-diag] stopRecording', {
      audioSentSamples: this.audioSentSamples,
      audioDurSec: audioDur.toFixed(2),
      wallTimeSec: wallTimeSec.toFixed(2),
      durationRatio: pttHoldMs > 0 ? (audioDur / wallTimeSec).toFixed(3) : 'N/A',
    })

    const durationRatio = wallTimeSec > 0 ? audioDur / wallTimeSec : 1
    if (wallTimeSec > 1 && (durationRatio > 2.0 || durationRatio < 0.3)) {
      addRuntimeEvent('warn', 'recorder', 'Unexpected audio byte count; sample rate may not match', {
        audioDurSec: audioDur.toFixed(2),
        wallTimeSec: wallTimeSec.toFixed(2),
        durationRatio: durationRatio.toFixed(3),
        audioSentSamples: this.audioSentSamples,
        recordedChunksCount: this.recordedChunks.length,
        recordedChunksTotalBytes: this.recordedChunks.reduce((s, c) => s + c.byteLength, 0),
      })
    }
    if (audioDur < 0.5) {
      addRuntimeEvent('info', 'recorder', 'Recording shorter than 0.5s; canceled provider and discarded audio')
      this.provider.cancel()
      this.finishRun(runId)
      this.resetToIdle()

      return
    }

    //
    const aiPolicy = resolveAiPolicy({
      ...(this.currentAiConfig ?? {
        workMode: this.provider.mode,
        aiEnabled: this.cachedAiEnabled,
        aiMinDurationSec: this.cachedAiMinDurationSec,
        }),
      audioDurationSec: audioDur,
    })
    const skipAiForShortSpeech = aiPolicy.reason === 'duration_below_min'

    const audioStats = this.audioStatsTotalFrames > 0 ? {
      avgRms: Math.round((this.audioStatsRmsSum / this.audioStatsTotalFrames) * 10000) / 10000,
      peakRms: Math.round(this.audioStatsPeakRms * 10000) / 10000,
      peakAmplitude: Math.round(this.audioStatsPeakAmplitude * 10000) / 10000,
      silenceRatio: Math.round((this.audioStatsSilentFrames / this.audioStatsTotalFrames) * 1000) / 1000,
      totalFrames: this.audioStatsTotalFrames,
    } : undefined

    const stopAccepted = this.provider.stop({
      pttHoldMs,
      aiPolicy,
      audioStats,
    })
    addRuntimeEvent('info', 'recorder', 'Stop sent', {
      audioSec: audioDur,
      pttHoldMs: Math.round(pttHoldMs),
      aiMinDurationSec: this.cachedAiMinDurationSec || undefined,
      skipAiForShortSpeech: skipAiForShortSpeech || undefined,
      stopAccepted,
    })

    if (!this.transition('processing')) {
      this.finishRun(runId)
      this.resetToIdle()
      return
    }
    this.processingCancelable = true

    this.beginAudioArchive(runId, this.recordedChunks.slice())

    if (!stopAccepted) {
      void this.failRunWithoutResult(runId, {
        audioDurationSec: audioDur,
        wallTimeSec,
        failReason: t('recorder.connectionLost'),
        failReasonCode: 'connection_lost',
        title: t('recorder.connectionLostTitle'),
        detail: t('recorder.connectionLostDetail'),
      })
      return
    }

    const processingTimeoutMs = this.computeProcessingTimeoutMs(audioDur)
    addRuntimeEvent('info', 'recorder', 'Entered processing', {
      audioSec: audioDur,
      timeoutMs: processingTimeoutMs,
      mode: this.provider.mode,
      audioStats,
    })
    this.overlayService.showThinking(audioDur, runId)
    let insertionExtensions = 0
    const onProcessingTimeout = () => {
      if (this.state !== 'processing' || !this.isRunCurrent(runId)) return
      if (this.textInsertionInFlight) {
        if (insertionExtensions < MAX_INSERTION_TIMEOUT_EXTENSIONS) {
          insertionExtensions++
          addRuntimeEvent('warn', 'recorder', 'Processing timed out while text insertion is active; extending wait', {
            runId,
            extension: insertionExtensions,
            extendByMs: INSERTION_TIMEOUT_EXTENSION_MS,
          })
          this.processingTimeoutId = setTimeout(onProcessingTimeout, INSERTION_TIMEOUT_EXTENSION_MS)
          return
        }
        this.handleInsertionStuck(
          runId,
          this.textBeingInserted,
          processingTimeoutMs + insertionExtensions * INSERTION_TIMEOUT_EXTENSION_MS,
        )
        return
      }
      const timedOutCtx: TimedOutProcessingContext = {
        runId,
        timedOutAt: Date.now(),
        settled: false,
        audioDurationSec: audioDur,
        wallTimeSec,
        promptResolution: this.currentPromptResolution ? { ...this.currentPromptResolution } : null,
        appContext: this.currentActiveAppContext ? { ...this.currentActiveAppContext } : null,
        audioChunks: this.recordedChunks.slice(),
        probeResult: this.cachedProbeResult ? { ...this.cachedProbeResult } : null,
      }
      this.timedOutProcessingContext = timedOutCtx
      this.lateResultAbandoned = false
      this.lateResultRunId = runId
      addRuntimeEvent('warn', 'recorder', 'Processing timed out; waiting out the late-final grace period', {
        audioSec: audioDur,
        timeoutMs: processingTimeoutMs,
        lateFinalGraceMs: LATE_FINAL_GRACE_MS,
      })

      this.overlayService.showAwaitingLateResult(LATE_FINAL_GRACE_MS / 1000, runId)

      const historyMeta = this.buildHistoryMetadata(timedOutCtx.promptResolution, timedOutCtx.appContext)
      window.setTimeout(() => {
        if (timedOutCtx.settled) return
        timedOutCtx.settled = true
        if (this.timedOutProcessingContext === timedOutCtx) {
          this.timedOutProcessingContext = null
          this.provider.cancel()

        }
        void (async () => {
          const stillWaiting = !this.lateResultAbandoned && this.isRunCurrent(timedOutCtx.runId)
          if (stillWaiting) {
            await this.failRunWithCard(timedOutCtx.runId, {
              title: t('recorder.processingTimeoutTitle'),
              detail: t('recorder.processingTimeoutDetail'),
              audioDurationSec: timedOutCtx.audioDurationSec,
              wallTimeSec: timedOutCtx.wallTimeSec,
              failReason: t('recorder.processingTimeout'),
              failReasonCode: 'processing_timeout',
              historyMeta,
            })
          } else {
            await this.archiveFailedRun({
              runId: timedOutCtx.runId,
              audioDurationSec: timedOutCtx.audioDurationSec,
              wallTimeSec: timedOutCtx.wallTimeSec,
              failReason: t('recorder.processingTimeout'),
              failReasonCode: 'processing_timeout',
              historyMeta,
            })
          }
          this.finishRun(timedOutCtx.runId)
          if (this.lateResultRunId === timedOutCtx.runId) {
            this.lateResultRunId = 0
            this.lateResultAbandoned = false
          }
        })()
      }, LATE_FINAL_GRACE_MS)

      this.resetToIdle({ preserveLateFinalContext: true, keepOverlay: true })
    }
    this.processingTimeoutId = setTimeout(onProcessingTimeout, processingTimeoutMs)
  }

  // ── Toggle / hands-free ──

  private pttToggle(isHandsFree = false) {
    const now = Date.now()
    if (now - this.lastToggleTime < 500) {
      addRuntimeEvent('info', 'ptt', 'Ignored toggle request', {
        isHandsFree,
        ignoreReason: 'cooldown',
        recorderState: this.state,
      })
      return
    }
    this.lastToggleTime = now

    if (this.state === 'idle') {
      if (isHandsFree) {
        this.handsFreeMode = true
        this.pttSuppressed = true
        setTimeout(() => { this.pttSuppressed = false }, 500)
      }
      addRuntimeEvent('info', 'ptt', 'toggle -> startRecording', {
        isHandsFree,
        recorderState: this.state,
      })
      void this.startRecording()
      return
    }

    if (this.state === 'recording') {
      if (isHandsFree || !this.handsFreeMode) {
        this.handsFreeMode = false
        addRuntimeEvent('info', 'ptt', 'toggle -> stopRecording', {
          isHandsFree,
          recorderState: this.state,
        })
        void this.stopRecording()
      }
      return
    }

    addRuntimeEvent('info', 'ptt', 'Ignored toggle request', {
      isHandsFree,
      ignoreReason: 'state_not_toggleable',
      recorderState: this.state,
      handsFreeMode: this.handsFreeMode,
    })
  }

  private getPTTEventContext(payload?: unknown) {
    const p = (payload && typeof payload === 'object')
      ? (payload as PTTEventPayload)
      : {}
    return {
      source: p.source || 'unknown',
      keycode: p.keycode,
      rawcode: p.rawcode,
      modifiers: {
        alt: p.altKey,
        ctrl: p.ctrlKey,
        shift: p.shiftKey,
      },
      reason: p.reason,
      pttSetting: p.pttSetting,
      timestamp: p.timestamp,
      recorderState: this.state,
      handsFreeMode: this.handsFreeMode,
      pttSuppressed: this.pttSuppressed,
    }
  }

  private logPTTEvent(event: 'down' | 'up' | 'toggle' | 'hands_free', payload?: unknown) {
    addRuntimeEvent('info', 'ptt', `event:${event}`, this.getPTTEventContext(payload))
  }

  private notePTTDown(payload?: unknown) {
    const p = (payload && typeof payload === 'object')
      ? (payload as PTTEventPayload)
      : {}
    this.lastPTTUpUsedModifier = Boolean(
      p.altKey
      || p.ctrlKey
      || p.shiftKey
      || this.isModifierPTTSetting(p.pttSetting),
    )
  }

  private notePTTUp(payload?: unknown) {
    const p = (payload && typeof payload === 'object')
      ? (payload as PTTEventPayload)
      : {}
    this.lastPTTUpAt = Date.now()
    this.lastPTTUpUsedModifier = Boolean(
      p.altKey
      || p.ctrlKey
      || p.shiftKey
      || this.isModifierPTTSetting(p.pttSetting),
    )
  }

  private isModifierPTTSetting(pttSetting?: string) {
    return _isModifierPTTSetting(pttSetting)
  }

  private async waitForModifierPTTReleaseIfNeeded() {
    if (!this.lastPTTUpUsedModifier || this.lastPTTUpAt <= 0) return
    const elapsedMs = Date.now() - this.lastPTTUpAt
    if (elapsedMs >= MODIFIER_PTT_RELEASE_GUARD_MS) return
    const waitMs = MODIFIER_PTT_RELEASE_GUARD_MS - elapsedMs
    addRuntimeEvent('info', 'recorder', 'Waiting for modifier keys to settle before inserting text', {
      waitMs,
      lastPTTUpAt: this.lastPTTUpAt,
    })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  private summarizeAppContext(context: ActiveAppContext | null) {
    return _summarizeAppContext(context)
  }

  private buildStatsAppId(appContext: ActiveAppContext | null, promptResolution: PromptResolution | null) {
    return _buildStatsAppId(appContext, promptResolution?.appId)
  }

  private buildHistoryMetadata(
    promptResolution?: PromptResolution | null,
    appContext?: ActiveAppContext | null,
  ) {
    const resolved = promptResolution || this.currentPromptResolution || undefined
    const ctx = appContext === undefined ? this.currentActiveAppContext : appContext
    return {
      appId: resolved?.appId,
      appName: resolved?.appName,
      windowTitle: ctx?.windowTitle || undefined,
      processName: ctx?.processName || undefined,
      windowClass: ctx?.windowClass || undefined,
      promptPresetId: resolved?.preset.id,
      promptPresetName: resolved?.preset.name,
      promptRuleId: resolved?.matchedRule?.id,
      promptSummary: resolved?.summary,
      workMode: this.provider.mode,
    }
  }

  private async buildProviderMetadata(finalResult?: FinalResult): Promise<{
    asrProvider?: string
    aiProvider?: string
    aiModel?: string
    aiSource?: FinalResult['aiSource']
    aiStatus?: FinalResult['aiStatus']
  }> {
    const mode = this.provider.mode
    const executionMeta = {
      aiSource: finalResult?.aiSource,
      aiStatus: finalResult?.aiStatus,
    }
    if (mode === 'cloud_api') {
      const asrProviderKey = await getSetting('cloudAsr.provider', '') as string
      //
      const asrSelectedModel = await getSetting('cloudAsr.model', '') as string
      const asrProvider = asrProviderKey
        ? resolveAsrDisplayModel(asrProviderKey, asrSelectedModel)
        : 'cloud'
      const aiProvider = finalResult?.aiProvider || await getSetting('cloudAi.provider', '') as string
      const aiModel = finalResult?.aiModel || await getSetting('cloudAi.model', '') as string
      return { asrProvider, aiProvider: aiProvider || undefined, aiModel: aiModel || undefined, ...executionMeta }
    }
    if (mode === 'local') {
      const modelId = await getSetting('localAsr.modelId', '') as string
      const aiEnabled = Boolean(await getSetting('aiEnabled', false))
      const aiProvider = finalResult?.aiProvider
        || (aiEnabled ? await getSetting('cloudAi.provider', '') as string : undefined)
      const aiModel = finalResult?.aiModel
        || (aiEnabled ? await getSetting('cloudAi.model', '') as string : undefined)
      return { asrProvider: modelId || 'local', aiProvider, aiModel: aiModel || undefined, ...executionMeta }
    }
    return executionMeta
  }

  private computeProcessingTimeoutMs(audioDurationSec: number) {
    return _computeProcessingTimeoutMs(audioDurationSec, this.provider.mode)
  }

  private consumeTimedOutProcessingContext() {
    const context = this.timedOutProcessingContext
    if (!context) return null
    if (!this.isRunCurrent(context.runId)) {
      this.timedOutProcessingContext = null
      return null
    }
    if (Date.now() - context.timedOutAt > LATE_FINAL_GRACE_MS) return null
    this.timedOutProcessingContext = null
    context.settled = true
    return context
  }

  private async processFinalResult(
    result: FinalResult,
    context: TimedOutProcessingContext,
    options: { allowInsertionWhenIdle: boolean; source: 'processing' | 'late_after_timeout' },
  ) {
    const runId = context.runId
    if (!this.isRunCurrent(runId)) return

    // New clients may talk to an older server that does not understand text_context. In that case
    // contextApplied is absent: paste the original selection back unchanged instead of replacing it
    // with a spoken edit command.
    const { baseText, rawAsr, selectedEditWasApplied } = resolveContextAwareOutput({
      asrText: result.asrText,
      llmText: result.llmText,
      contextApplied: result.contextApplied,
      textContext: context.appContext?.textContext,
    })
    let textToPaste: string
    try {
      textToPaste = selectedEditWasApplied
        ? await applyTextTransforms(baseText, { rawAsr })
        : baseText
    } catch (error) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('warn', 'recorder', 'Text post-processing failed', { error: String(error), runId })
      if (baseText && baseText.trim()) {
        this.showFallbackAndReset(baseText, 'text_transform_failed', runId)
      } else {
        if (this.state === 'processing') {
          this.overlayService.showNoSpeech('no_text', {
            reason: 'text_transform_failed',
            mode: this.provider.mode,
            error: String(error),
            runId,
          })
        }
        this.finishRun(runId)
        if (this.state === 'processing') this.resetToIdle({ keepOverlay: true })
      }
      return
    }
    if (!this.isRunCurrent(runId)) return

    const hasText = Boolean(textToPaste && textToPaste.trim())
    const audioDur = context.audioDurationSec
    const wallSec = context.wallTimeSec > 0 ? context.wallTimeSec : audioDur
    const promptResolution = context.promptResolution
    const appContext = context.appContext
    let historyArtifact: { runId: number; recordId: string; audioFilePath?: string } | null = null

    addRuntimeEvent('info', 'recorder', 'Final result received', {
      runId,
      hasText,
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      durationSec: result.durationSec,
      audioSec: audioDur,
      textLen: textToPaste ? textToPaste.length : 0,
      source: options.source,
      contextApplied: result.contextApplied,
    })

    try {
      const historyEnabled = await getSetting('historyEnabled', true)
      if (!this.isRunCurrent(runId)) return
      if (historyEnabled) {
        const archived = await this.takeArchivedAudio(runId)
        const recordId = archived?.recordId
          ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
        historyArtifact = { runId, recordId, audioFilePath: archived?.audioFilePath }

        if (this.isRunCanceled(runId)) {
          await this.discardCanceledHistory(historyArtifact)
          return
        }
        const providerMeta = await this.buildProviderMetadata(result)
        if (this.isRunCanceled(runId)) {
          await this.discardCanceledHistory(historyArtifact)
          return
        }

        this.pendingHistoryArtifact = historyArtifact
        await addHistory({
          id: recordId,
          timestamp: Date.now(),
          asrText: result.asrText,
          llmText: textToPaste,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
          durationSec: wallSec,
          audioDurationSec: audioDur > 0 ? audioDur : undefined,
          asrDurationSec: result.durationSec > 0 ? result.durationSec : undefined,
          charCount: hasText ? textToPaste.length : 0,
          isEmpty: !hasText,
          failReason: hasText
            ? undefined
            : result.asrText?.trim()
              ? t('recorder.emptyAfterProcessing')
              : t('recorder.noTranscript'),
          failReasonCode: hasText
            ? undefined
            : result.asrText?.trim()
              ? 'empty_after_processing'
              : 'no_transcript',
          audioFilePath: historyArtifact.audioFilePath,
          ...this.buildHistoryMetadata(promptResolution, appContext),
          ...providerMeta,
        })
        if (this.isRunCanceled(runId)) {
          await this.discardCanceledHistory(historyArtifact)
          return
        }
        void bridge.emit('history-updated')
      }
    } catch (error) {
      if (historyArtifact) await this.discardCanceledHistory(historyArtifact)
      addRuntimeEvent('warn', 'recorder', 'Failed to write history entry', { error: String(error), runId })
    }

    if (!this.isRunCurrent(runId)) {
      if (this.isRunCanceled(runId) && historyArtifact) {
        await this.discardCanceledHistory(historyArtifact)
      }
      return
    }

    if (!hasText) {
      const asrHadText = Boolean(result.asrText?.trim())
      const silenceProven = !asrHadText && this.hasSilenceEvidence()
      const diagnostic = {
        reason: 'final_empty',
        mode: this.provider.mode,
        audioSec: Number(audioDur.toFixed(1)),
        asrMs: result.asrMs,
        llmMs: result.llmMs,
        asrLen: result.asrText?.length ?? 0,
        llmLen: result.llmText?.length ?? 0,
        asrHadText,
        silenceProven,
        peakAmplitude: Math.round(this.audioStatsPeakAmplitude * 10000) / 10000,
        runId,
      }
      if (asrHadText) {
        addRuntimeEvent('warn', 'recorder', 'Text processing emptied the transcript', diagnostic)
        this.overlayService.showFailure({
          title: t('recorder.emptyAfterProcessingTitle'),
          detail: t('recorder.emptyAfterProcessingDetail'),
          recovery: historyArtifact?.audioFilePath ? 'history' : 'none',
          token: runId,
        })
        this.activeFallbackToken = runId
      } else {
        this.overlayService.showNoSpeech(silenceProven ? 'silent' : 'no_text', diagnostic)
      }
      this.finishRun(runId)
      if (this.state === 'processing') {
        this.resetToIdle({ keepOverlay: true })
      }
      return
    }

    void this.updatePersonalizationFromFinal(runId, textToPaste, promptResolution, appContext)

    this.textInsertionInFlight = true
    this.textBeingInserted = textToPaste
    this.armInsertionTimeout(runId, textToPaste)
    try {
      await this.handleTextInsertion(textToPaste, {
        allowWhenIdle: options.allowInsertionWhenIdle,
        runId,
        probeResult: context.probeResult,
      })
    } catch (error) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'recorder', 'Text insertion threw; showing fallback card', { error: String(error), runId })
      this.showFallbackAndReset(textToPaste, 'paste_exception', runId)
    } finally {
      this.clearInsertionTimeout()
      this.textInsertionInFlight = false
      this.textBeingInserted = ''
    }
  }

  private async updatePersonalizationFromFinal(
    runId: number,
    finalText: string,
    promptResolution: PromptResolution | null,
    appContext: ActiveAppContext | null,
  ) {
    if (!finalText.trim() || !this.isRunCurrent(runId)) return

    try {
      const wordCount = finalText.length
      const appId = this.buildStatsAppId(appContext, promptResolution)

      const nextStats = await recordSessionStats(appId, wordCount)
      if (!this.isRunCurrent(runId)) return
      this.cachedUserStats = nextStats
      addRuntimeEvent('info', 'personalization', 'session stats recorded', {
        appId,
        appName: promptResolution?.appName,
        wordCount,
        totalWords: this.cachedUserStats.totalWords,
        totalSessions: this.cachedUserStats.totalSessions,
      })
    } catch (error) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('warn', 'personalization', 'failed to record session stats', {
        error: String(error),
      })
    }
  }
}
