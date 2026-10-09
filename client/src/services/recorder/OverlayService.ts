import { getLocale, t } from '@/i18n'
import * as bridge from '../bridge'
import { addRuntimeEvent } from '../debugLog'
import { getSetting } from '../store'
import { clampSec } from '../timeModel'
import {
  formatRecordingLimit,
  OVERLAY_WIDTH_PRESETS,
  type OverlayCommonPayload,
  type OverlayWaveTheme,
  type OverlayWidthPreset,
} from './types'
import type { MicSourceMode } from './micSourceReminder'

type OverlayVisualState =
  | 'waiting'
  | 'listening'
  | 'thinking'
  | 'fallback'
  | 'failure'
  | 'error'
  | 'toast'

const CARD_KEEPALIVE_INTERVAL_MS = 8000

const FAILURE_CARD_VISIBLE_MS = 5 * 1000

export type FailureRecovery = 'unknown' | 'history' | 'none'

interface MicSourceHint {
  mode: MicSourceMode
  label: string
}

const MIC_SOURCE_HINT_DURATION_MS = 3000

function normalizeTheme(value: unknown): OverlayWaveTheme {
  if (value === 'black-white' || value === 'black-blue' || value === 'black-rainbow') {
    return value
  }
  return 'black-blue'
}

function normalizeWidthPreset(value: unknown): OverlayWidthPreset {
  if (value === 'short' || value === 'medium' || value === 'long') return value
  return 'long'
}

export class OverlayService {
  private theme: OverlayWaveTheme = 'black-rainbow'
  private showDuration = true
  private readySoundEnabled = true
  private widthPreset: OverlayWidthPreset = 'medium'
  private lastFrameAt = 0
  private tickerId: ReturnType<typeof setInterval> | null = null
  private fallbackHideId: ReturnType<typeof setTimeout> | null = null
  /** Persistent warning text — included in every overlay update until cleared */
  private activeWarning = ''
  private timeoutWarningHideId: ReturnType<typeof setTimeout> | null = null
  private streamingText = ''
  private streamingActive = false
  private currentState: OverlayVisualState = 'waiting'
  private activeFailureCard: { title: string; detail: string } | null = null

  private activeMicSourceHint: MicSourceHint | null = null
  private micSourceHintHideId: ReturnType<typeof setTimeout> | null = null
  private micSourceHintGeneration = 0
  private cardKeepAliveId: ReturnType<typeof setInterval> | null = null
  private activeCardToken = 0
  private activeCardHotkeys: bridge.CardHotkeyAction[] = []
  private activeCardEscapeMode: bridge.EscapeActionMode = 'off'

  constructor(private readonly getElapsedSec: () => number) { }

  async refreshSettings() {
    this.theme = normalizeTheme(await getSetting('overlayWaveTheme', 'black-rainbow'))
    this.showDuration = Boolean(await getSetting('overlayShowDuration', true))
    this.readySoundEnabled = Boolean(await getSetting('readySoundEnabled', true))
    this.widthPreset = normalizeWidthPreset(await getSetting('overlayWidth', 'medium'))
  }

  private readySoundCtx: AudioContext | null = null

  private playReadySound() {
    if (!this.readySoundEnabled) return
    try {
      if (!this.readySoundCtx || this.readySoundCtx.state === 'closed') {
        this.readySoundCtx = new AudioContext()
      }
      const ctx = this.readySoundCtx
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => this.emitReadyTone(ctx)).catch(() => { /* ignore */ })
      } else {
        this.emitReadyTone(ctx)
      }
    } catch { /* ignore */ }
  }

  private emitReadyTone(ctx: AudioContext) {
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.2, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.15)
    } catch { /* ignore */ }
  }

  getCommonPayload(): OverlayCommonPayload {
    const cfg = OVERLAY_WIDTH_PRESETS[this.widthPreset]
    return {
      theme: this.theme,
      showDuration: this.showDuration,
      baseWidth: cfg.windowWidth,
      barCount: cfg.barCount,
      locale: getLocale(),
    }
  }

  getBarCount(): number {
    return OVERLAY_WIDTH_PRESETS[this.widthPreset].barCount
  }

  private setEscapeMode(mode: bridge.EscapeActionMode, token = 0) {
    void bridge.setEscapeActionMode(mode, token).catch(() => {  })
  }

  private enterTransientState(mode: bridge.EscapeActionMode, token = 0) {
    this.stopCardKeepAlive()
    this.setEscapeMode(mode, token)
  }

  private failureCardPayload() {
    return {
      failureTitle: this.activeFailureCard?.title ?? '',
      failureDetail: this.activeFailureCard?.detail ?? '',
    }
  }

  private getMicSourceHintPayload() {
    return this.activeMicSourceHint
      ? {
        micSourceMode: this.activeMicSourceHint.mode,
        micSourceLabel: this.activeMicSourceHint.label,
      }
      : {
        micSourceMode: null,
        micSourceLabel: '',
      }
  }

  private listeningPayload(overrides: Record<string, unknown> = {}) {
    return {
      state: 'listening',
      elapsedSec: clampSec(this.getElapsedSec()),
      ...(this.activeWarning ? { warning: this.activeWarning } : {}),
      ...(this.streamingActive ? { streaming: true } : {}),
      ...(this.streamingText ? { streamingText: this.streamingText } : {}),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
      ...overrides,
    }
  }

  private clearMicSourceHint() {
    this.micSourceHintGeneration++
    if (this.micSourceHintHideId) {
      clearTimeout(this.micSourceHintHideId)
      this.micSourceHintHideId = null
    }
    this.activeMicSourceHint = null
  }

  /** Briefly confirm the actual input route after a successful microphone open. */
  showMicSourceHint(hint: MicSourceHint) {
    this.clearMicSourceHint()
    this.activeMicSourceHint = hint
    const generation = this.micSourceHintGeneration

    void bridge.updateOverlay(this.listeningPayload({ state: this.currentState }))

    this.micSourceHintHideId = setTimeout(() => {
      if (generation !== this.micSourceHintGeneration) return
      this.micSourceHintHideId = null
      this.activeMicSourceHint = null
      void bridge.updateOverlay(this.listeningPayload({ state: this.currentState }))
    }, MIC_SOURCE_HINT_DURATION_MS)
  }

  async disableEscapeAction(): Promise<void> {
    this.stopCardKeepAlive()
    try {
      await bridge.setEscapeActionMode('off', 0)
    } catch {  }
  }

  showWaiting() {
    this.currentState = 'waiting'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    this.clearFallbackHideTimer()
    void bridge.presentOverlay({
      state: 'waiting',
      elapsedSec: 0,
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  startListeningTicker(token = 0) {
    this.currentState = 'listening'
    this.stopListeningTicker()
    this.enterTransientState(token > 0 ? 'cancel_recording' : 'off', token)
    this.playReadySound()
    this.pushListeningBars(undefined, true)
    this.tickerId = setInterval(() => {
      void bridge.updateOverlay(this.listeningPayload())
    }, 33)
  }

  setStreamingActive(on: boolean) {
    this.streamingActive = on
  }

  setStreamingText(text: string) {
    this.streamingText = text || ''
  }

  resetStreamingText() {
    this.streamingText = ''
    this.streamingActive = false
  }

  stopListeningTicker() {
    if (this.tickerId) {
      clearInterval(this.tickerId)
      this.tickerId = null
    }
  }

  pushListeningBars(bars?: number[], force = false) {
    const now = Date.now()
    if (!force && now - this.lastFrameAt < 33) return
    this.lastFrameAt = now
    void bridge.updateOverlay(this.listeningPayload({ bars }))
  }

  showThinking(elapsedSec: number, token = 0) {
    this.currentState = 'thinking'
    this.enterTransientState(token > 0 ? 'cancel_processing' : 'off', token)
    void bridge.updateOverlay({
      state: 'thinking',
      elapsedSec: clampSec(elapsedSec),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  showTimeoutWarning() {
    const text = t('overlay.warnMaxDuration', { limit: formatRecordingLimit() })
    this.activeWarning = text
    void bridge.updateOverlay(this.listeningPayload({ warning: text, warningTone: 'warn' }))

    if (this.timeoutWarningHideId) clearTimeout(this.timeoutWarningHideId)
    this.timeoutWarningHideId = setTimeout(() => {
      this.timeoutWarningHideId = null
      if (this.activeWarning !== text) return
      this.activeWarning = ''
      void bridge.updateOverlay(this.listeningPayload({ warning: '', warningTone: 'warn' }))
    }, 4000)
  }

  showLowVolumeWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({
      warning: t('overlay.warnLowVolume'),
      warningTone: 'warn',
    }))
  }

  showNoSignalWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({
      warning: t('overlay.warnNoSignal'),
      warningTone: 'error',
    }))
  }

  showMicMutedAlert() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({
      warning: t('overlay.warnMicMuted'),
      warningTone: 'error',
    }))
  }

  /** Clear transient warnings (low volume etc.) — does NOT clear timeout warning */
  clearWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({ warning: '', warningTone: 'warn' }))
  }

  hasStickyWarning() {
    return !!this.activeWarning
  }

  /** Reset all warnings including persistent ones (called on recording stop/reset) */
  resetWarnings() {
    if (this.timeoutWarningHideId) {
      clearTimeout(this.timeoutWarningHideId)
      this.timeoutWarningHideId = null
    }
    this.activeWarning = ''
  }

  showFallback(text: string, reason: string, token = 0) {
    this.currentState = 'fallback'
    this.clearMicSourceHint()
    addRuntimeEvent('info', 'overlay', 'Showing result card', {
      reason,
      textLen: text.length,
      token,
    })
    void bridge.presentOverlay({
      state: 'fallback',
      fallbackText: text,
      fallbackReason: reason,
      cardToken: token,
      ...this.getCommonPayload(),
    })
    this.beginCardLifecycle(token, 'dismiss_fallback', text ? ['copy'] : [], { autoHide: false })
  }

  showFailure(params: {
    title: string
    detail?: string
    recovery: FailureRecovery
    token?: number
  }) {
    const token = params.token ?? 0
    this.currentState = 'failure'
    this.clearMicSourceHint()
    this.activeFailureCard = { title: params.title, detail: params.detail || '' }
    addRuntimeEvent('warn', 'overlay', 'Showing failure card', {
      title: params.title,
      recovery: params.recovery,
      token,
    })
    void bridge.presentOverlay({
      state: 'failure',
      ...this.failureCardPayload(),
      failureRecovery: params.recovery,
      cardToken: token,
      ...this.getCommonPayload(),
    })
    this.beginCardLifecycle(token, 'dismiss_fallback', [], { autoHide: true })
  }

  updateFailureRecovery(recovery: FailureRecovery, token: number) {
    if (this.currentState !== 'failure') return
    if (token !== this.activeCardToken) return
    void bridge.updateOverlay({
      state: 'failure',
      ...this.failureCardPayload(),
      failureRecovery: recovery,
      ...this.getCommonPayload(),
    })
  }

  showAwaitingLateResult(graceSec: number, token: number) {
    this.currentState = 'thinking'
    this.clearMicSourceHint()
    this.enterTransientState(token > 0 ? 'abandon_late_result' : 'off', token)
    void bridge.presentOverlay({
      state: 'thinking',
      thinkingNote: 'late',
      elapsedSec: clampSec(graceSec),
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
  }

  private beginCardLifecycle(
    token: number,
    escapeMode: bridge.EscapeActionMode,
    hotkeys: bridge.CardHotkeyAction[],
    options: { autoHide: boolean },
  ) {
    this.stopCardKeepAlive()
    this.activeCardToken = token
    this.activeCardHotkeys = token > 0 ? hotkeys : []
    this.activeCardEscapeMode = token > 0 ? escapeMode : 'off'

    this.setEscapeMode(this.activeCardEscapeMode, token)
    this.setCardHotkeys(this.activeCardHotkeys, token)

    if (token > 0) {
      this.cardKeepAliveId = setInterval(() => {
        this.setEscapeMode(this.activeCardEscapeMode, this.activeCardToken)
        this.setCardHotkeys(this.activeCardHotkeys, this.activeCardToken)
      }, CARD_KEEPALIVE_INTERVAL_MS)
    }

    this.clearFallbackHideTimer()
    if (options.autoHide) {
      this.fallbackHideId = setTimeout(() => {
        addRuntimeEvent('info', 'overlay', 'Card hit its visible time limit; hiding', {
          token,
          visibleMs: FAILURE_CARD_VISIBLE_MS,
        })
        this.hide()
      }, FAILURE_CARD_VISIBLE_MS)
    }
  }

  noteCardDismissed(token: number) {
    if (token !== this.activeCardToken) {
      addRuntimeEvent('info', 'overlay', 'Ignored a dismissal for a card that is no longer active', {
        token,
        activeCardToken: this.activeCardToken,
      })
      return
    }
    this.currentState = 'toast'
    this.clearFallbackHideTimer()
    this.enterTransientState('off', 0)
  }

  private stopCardKeepAlive() {
    if (this.cardKeepAliveId) {
      clearInterval(this.cardKeepAliveId)
      this.cardKeepAliveId = null
    }
    if (this.activeCardHotkeys.length > 0) {
      this.setCardHotkeys([], 0)
    }
    this.activeCardToken = 0
    this.activeCardHotkeys = []
    this.activeCardEscapeMode = 'off'
  }

  private setCardHotkeys(actions: bridge.CardHotkeyAction[], token: number) {
    void bridge.setCardHotkeys(actions, token).catch(() => {  })
  }

  clearFallbackHideTimer() {
    if (this.fallbackHideId) {
      clearTimeout(this.fallbackHideId)
      this.fallbackHideId = null
    }
  }

  hide() {
    this.clearMicSourceHint()
    this.activeFailureCard = null
    this.clearFallbackHideTimer()
    this.enterTransientState('off', 0)
    void bridge.hideOverlay()
  }

  showPresetSwitched(name: string) {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t('overlay.toastPresetSwitched', { name }),
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 1600)
  }

  showAiCleanupToggled(enabled: boolean) {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t(enabled ? 'overlay.toastAiCleanupOn' : 'overlay.toastAiCleanupOff'),
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 1400)
  }

  showNoSpeech(reason: 'silent' | 'no_text', diagnostic?: Record<string, unknown>) {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    addRuntimeEvent('warn', 'recorder', 'Showing no-speech warning', { ...(diagnostic ?? {}), reason })
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t(reason === 'silent' ? 'overlay.toastNoSpeech' : 'overlay.toastNoText'),
      toastTone: 'warn',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 1500)
  }

  showCanceled() {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t('overlay.toastCanceled'),
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 900)
  }

  showError(message: string) {
    this.currentState = 'error'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'error',
      errorMessage: message,
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 4000)
  }

  dispose() {
    this.stopListeningTicker()
    this.resetStreamingText()
    this.hide()
  }
}
