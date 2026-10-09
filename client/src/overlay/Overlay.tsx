import * as bridge from '../services/bridge'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Copy, Check, MicVocal, X } from 'lucide-react'
import { isLocale, setLocale } from '@/i18n'
import { useT } from '@/i18n/useT'
import { addRuntimeEvent } from '../services/debugLog'
import { formatRecordingTimer } from '../services/recorder/types'

type OverlayState =
  | 'blank'
  | 'waiting'
  | 'listening'
  | 'thinking'
  | 'fallback'
  | 'failure'
  | 'error'
  | 'toast'
type FailureRecovery = 'unknown' | 'history' | 'none'
type RecordingVisualPhase = 'preparing' | 'listening'
type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

interface OverlayPayload {
  state?: OverlayState
  bars?: number[]
  elapsedSec?: number
  theme?: OverlayWaveTheme
  showDuration?: boolean
  barCount?: number
  fallbackText?: string
  fallbackReason?: string
  failureTitle?: string
  failureDetail?: string
  failureRecovery?: FailureRecovery
  cardToken?: number
  thinkingNote?: 'late'
  errorMessage?: string
  warning?: string
  warningTone?: 'warn' | 'error'
  toastText?: string
  toastTone?: 'info' | 'warn'
  micSourceMode?: 'auto' | 'fixed' | null
  micSourceLabel?: string
  locale?: string
  _overlayShowId?: number
  _overlayGeneration?: number
  _overlayProbe?: boolean
}

const DEFAULT_BAR_COUNT = 24
const IDLE_BARS = Array(DEFAULT_BAR_COUNT).fill(3)

function normalizeTheme(theme: unknown): OverlayWaveTheme {
  if (theme === 'black-white' || theme === 'black-blue' || theme === 'black-rainbow') {
    return theme
  }
  return 'black-blue'
}

function getListeningBarColor(index: number, total: number, theme: OverlayWaveTheme): string {
  const safeTotal = Math.max(1, total - 1)
  const t = index / safeTotal

  if (theme === 'black-white') {
    return '#f1f5f9'
  }

  if (theme === 'black-rainbow') {
    const hue = 140 - Math.round(t * 110)
    const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
    return `hsl(${hue} 95% ${lightness}%)`
  }

  const hue = 190 + Math.round(t * 30)
  const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
  return `hsl(${hue} 90% ${lightness}%)`
}

function getTimerColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e5e7eb'
  if (theme === 'black-rainbow') return '#fef08a'
  return '#bae6fd'
}

function getThinkingColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e2e8f0'
  if (theme === 'black-rainbow') return '#facc15'
  return '#38bdf8'
}

export default function Overlay() {
  const t = useT()
  const [state, setState] = useState<OverlayState>('blank')
  const [recordingVisualPhase, setRecordingVisualPhase] = useState<RecordingVisualPhase>('preparing')
  const [bars, setBars] = useState<number[]>(IDLE_BARS)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [theme, setTheme] = useState<OverlayWaveTheme>('black-blue')
  const [showDuration, setShowDuration] = useState(true)
  const [barCount, setBarCount] = useState(DEFAULT_BAR_COUNT)
  const [presentationId, setPresentationId] = useState(0)
  const [fallbackText, setFallbackText] = useState('')
  const [failureTitle, setFailureTitle] = useState('')
  const [failureDetail, setFailureDetail] = useState('')
  const [failureRecovery, setFailureRecovery] = useState<FailureRecovery>('unknown')
  const [cardToken, setCardToken] = useState(0)
  const [fallbackReason, setFallbackReason] = useState('')
  const [thinkingNote, setThinkingNote] = useState<'late' | null>(null)
  const [copyError, setCopyError] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [toastText, setToastText] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'warn'>('info')
  const [copied, setCopied] = useState(false)
  const [thinkingDuration, setThinkingDuration] = useState(0)
  const [warning, setWarning] = useState('')
  const [warningTone, setWarningTone] = useState<'warn' | 'error'>('warn')
  const [micSourceMode, setMicSourceMode] = useState<'auto' | 'fixed' | null>(null)
  const [micSourceLabel, setMicSourceLabel] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardRef = useRef<{
    presentationId: number
    state: OverlayState
    text: string
    token: number
  }>({
    presentationId: 0,
    state: 'blank',
    text: '',
    token: 0,
  })
  const preparingPaintFrameRef = useRef<number | null>(null)
  const pendingListeningVisualRef = useRef(false)
  const elapsedSecRef = useRef(0)

  const calculateThinkingDuration = (recordingSec: number): number => {
    if (recordingSec <= 5) return 2
    if (recordingSec <= 15) return 3
    if (recordingSec <= 30) return 4
    if (recordingSec <= 60) return 5
    if (recordingSec <= 120) return 7
    if (recordingSec <= 180) return 9
    if (recordingSec <= 240) return 11
    return 13
  }

  useEffect(() => {
    let disposed = false
    let removeOverlayListener: (() => void) | null = null

    const cancelPreparingPaint = () => {
      if (preparingPaintFrameRef.current !== null) {
        cancelAnimationFrame(preparingPaintFrameRef.current)
        preparingPaintFrameRef.current = null
      }
    }

    const beginPreparingVisual = () => {
      cancelPreparingPaint()
      pendingListeningVisualRef.current = false
      setRecordingVisualPhase('preparing')
      preparingPaintFrameRef.current = requestAnimationFrame(() => {
        preparingPaintFrameRef.current = requestAnimationFrame(() => {
          preparingPaintFrameRef.current = null
          if (disposed || !pendingListeningVisualRef.current) return
          pendingListeningVisualRef.current = false
          setRecordingVisualPhase('listening')
        })
      })
    }

    const handleOverlayState = (data: unknown) => {
      const payload = data as OverlayPayload
      if (typeof payload._overlayShowId === 'number') setPresentationId(payload._overlayShowId)
      if (isLocale(payload.locale)) setLocale(payload.locale)
      const nextElapsedSec = typeof payload.elapsedSec === 'number'
        ? payload.elapsedSec
        : elapsedSecRef.current

      if (payload.state) {
        if (payload.state === 'waiting') {
          beginPreparingVisual()
        } else if (payload.state === 'listening') {
          if (preparingPaintFrameRef.current !== null) {
            pendingListeningVisualRef.current = true
          } else {
            setRecordingVisualPhase('listening')
          }
        } else {
          cancelPreparingPaint()
          pendingListeningVisualRef.current = false
        }
        setState(payload.state)
        if (payload.state !== 'listening') {
          setBars((prev) => Array(prev.length).fill(3))
        }
        setCopied(false)
        setCopyError(false)
        if (payload.state !== 'fallback' && hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
        if (payload.state === 'thinking') {
          setThinkingDuration(calculateThinkingDuration(nextElapsedSec))
          setThinkingNote(payload.thinkingNote ?? null)
        } else {
          setThinkingNote(null)
        }
        if (payload.state !== 'failure') {
          setFailureRecovery('unknown')
        }
      }

      if (Array.isArray(payload.bars) && payload.bars.length > 0) setBars(payload.bars)
      if (typeof payload.elapsedSec === 'number') {
        elapsedSecRef.current = payload.elapsedSec
        setElapsedSec(payload.elapsedSec)
      }
      if (typeof payload.showDuration === 'boolean') setShowDuration(payload.showDuration)
      if (payload.theme) setTheme(normalizeTheme(payload.theme))
      if (typeof payload.barCount === 'number' && payload.barCount > 0) setBarCount(payload.barCount)
      if (typeof payload.fallbackText === 'string') setFallbackText(payload.fallbackText)
      if (typeof payload.fallbackReason === 'string') setFallbackReason(payload.fallbackReason)
      if (typeof payload.cardToken === 'number') setCardToken(payload.cardToken)
      if (typeof payload.failureTitle === 'string') setFailureTitle(payload.failureTitle)
      if (typeof payload.failureDetail === 'string') setFailureDetail(payload.failureDetail)
      if (
        payload.failureRecovery === 'unknown'
        || payload.failureRecovery === 'history'
        || payload.failureRecovery === 'none'
      ) {
        setFailureRecovery(payload.failureRecovery)
      }
      if (typeof payload.errorMessage === 'string') setErrorMessage(payload.errorMessage)
      if (typeof payload.toastText === 'string') setToastText(payload.toastText)
      if (payload.toastTone === 'info' || payload.toastTone === 'warn') setToastTone(payload.toastTone)
      if (typeof payload.warning === 'string') setWarning(payload.warning)
      if (payload.warningTone === 'warn' || payload.warningTone === 'error') setWarningTone(payload.warningTone)
      if (payload.micSourceMode === 'auto' || payload.micSourceMode === 'fixed' || payload.micSourceMode === null) {
        setMicSourceMode(payload.micSourceMode)
      }
      if (typeof payload.micSourceLabel === 'string') setMicSourceLabel(payload.micSourceLabel)
      if (payload.state === 'waiting') {
        setElapsedSec(0)
        setWarning('')
        setWarningTone('warn')
        setMicSourceMode(null)
        setMicSourceLabel('')
        setBars((prev) => Array(prev.length).fill(3))
      }

      if (!payload._overlayProbe) return
      const showId = payload._overlayShowId
      const generation = payload._overlayGeneration
      if (typeof showId !== 'number' || typeof generation !== 'number') return

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (disposed) return
          const root = rootRef.current
          const content = root?.querySelector<HTMLElement>('[data-overlay-content]') ?? null
          const rootRect = root?.getBoundingClientRect()
          const contentRect = content?.getBoundingClientRect()
          const style = content ? window.getComputedStyle(content) : null
          const clippedTop = contentRect ? Math.max(0, -contentRect.top) : 0
          const healthy = Boolean(
            rootRect && contentRect
            && rootRect.width > 0 && rootRect.height > 0
            && contentRect.width > 0 && contentRect.height > 0
            && style?.display !== 'none'
            && style?.visibility !== 'hidden'
            && Number(style?.opacity ?? '1') > 0
          )
          void bridge.overlayRenderAck({
            showId,
            generation,
            healthy,
            overlayState: payload.state ?? 'unknown',
            documentVisibility: document.visibilityState,
            rootWidth: rootRect?.width ?? 0,
            rootHeight: rootRect?.height ?? 0,
            contentWidth: contentRect?.width ?? 0,
            contentHeight: contentRect?.height ?? 0,
            clippedTop,
            devicePixelRatio: window.devicePixelRatio,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            display: style?.display ?? 'missing',
            visibility: style?.visibility ?? 'missing',
            opacity: style?.opacity ?? 'missing',
          }).catch(() => { })
        })
      })
    }

    void bridge.listen<unknown>('overlay-state', (event) => handleOverlayState(event.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        removeOverlayListener = unlisten
        void bridge.overlayReady(window.devicePixelRatio).catch(() => { })
      })

    return () => {
      disposed = true
      cancelPreparingPaint()
      pendingListeningVisualRef.current = false
      removeOverlayListener?.()
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

  const copyHandlerRef = useRef<(source: 'button' | 'hotkey') => void>(() => { })
  copyHandlerRef.current = (source) => { void handleCopyFallback(source) }
  cardRef.current = { presentationId, state, text: fallbackText, token: cardToken }

  useEffect(() => {
    const removeCardHotkey = bridge.onCardHotkey(({ action, token }) => {
      if (action !== 'copy') return
      const card = cardRef.current
      if (card.state !== 'fallback' || !card.text || token !== card.token || token === 0) {
        addRuntimeEvent('info', 'overlay', 'Ignored a card hotkey that does not match the current card', {
          action,
          eventToken: token,
          cardToken: card.token,
          state: card.state,
        })
        return
      }
      copyHandlerRef.current('hotkey')
    })
    return removeCardHotkey
  }, [])

  const recordingPhase = state === 'waiting' || state === 'listening'
  const visuallyListening = state === 'listening' && recordingVisualPhase === 'listening'
  const showMicSourceHint = Boolean(
    micSourceMode
    && micSourceLabel.trim()
    && (visuallyListening || state === 'thinking'),
  )

  const { text: timerText, countdown: inCountdown, remainingSec } = useMemo(
    () => formatRecordingTimer(elapsedSec),
    [elapsedSec],
  )
  const urgent = inCountdown && remainingSec <= 10
  const normalizedBars = barCount === bars.length
    ? bars
    : Array.from({ length: barCount }, (_, index) => bars[index] ?? 3)
  const barBudget = warning && inCountdown
    ? Math.max(4, Math.floor(normalizedBars.length / 2))
    : (warning || inCountdown
      ? Math.max(6, Math.floor((normalizedBars.length * 2) / 3))
      : normalizedBars.length)
  const visibleBars = barBudget >= normalizedBars.length
    ? normalizedBars
    : normalizedBars.slice(0, barBudget)

  const timerColor = inCountdown
    ? (urgent ? '#fb923c' : '#fbbf24')
    : getTimerColor(theme)
  const thinkingColor = getThinkingColor(theme)

  const handleCopyFallback = async (source: 'button' | 'hotkey' = 'button') => {
    if (!fallbackText) return
    const cardAtStart = presentationId

    try {
      await bridge.copyText(fallbackText)
      if (cardAtStart !== cardRef.current.presentationId) {
        addRuntimeEvent('info', 'overlay', 'Ignored a copy result from a superseded card', {
          cardAtStart,
          currentCard: cardRef.current.presentationId,
        })
        return
      }
      setCopied(true)
      setCopyError(false)
      addRuntimeEvent('info', 'overlay', 'Result card copied', {
        textLen: fallbackText.length,
        source,
      })

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
      hideTimerRef.current = setTimeout(() => {
        if (cardAtStart !== cardRef.current.presentationId) return
        dismissCard('copied')
        hideTimerRef.current = null
      }, 500)
    } catch (error) {
      addRuntimeEvent('error', 'overlay', 'Result card copy failed', {
        error: String(error),
        source,
      })
      if (cardAtStart !== cardRef.current.presentationId) return
      setCopied(false)
      setCopyError(true)
    }
  }

  const dismissCard = (reason: string) => {
    const token = cardRef.current.token
    addRuntimeEvent('info', 'overlay', 'Card dismissed', { reason, state: cardRef.current.state, token })
    void bridge.setEscapeActionMode('off')
    void bridge.setCardHotkeys([])
    void bridge.hideOverlay()
    void bridge.notifyCardDismissed(reason, token).catch(() => {  })
  }

  const handleDismissCard = () => { dismissCard('user_closed') }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none flex h-full items-end justify-center pb-4"
    >
      {state === 'blank' ? null : state === 'fallback' ? (
        <div
          data-overlay-content
          className="pointer-events-auto flex w-full max-w-[520px] flex-col rounded-xl border px-4 py-4"
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <span className="block text-xs font-medium tracking-[0.16em]" style={{ color: 'var(--overlay-text-muted)' }}>{t('overlay.recognizedText')}</span>
              <span className="block text-xs" style={{ color: copyError ? '#fca5a5' : 'var(--overlay-text-dim)' }}>
                {copyError
                  ? t('overlay.copyFailedHint')
                  : fallbackReason === 'insertion_timeout'
                    ? t('overlay.insertionTimeoutHint')
                    : t('overlay.fallbackHint')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => { void handleCopyFallback('button') }}
                title={copied ? t('overlay.copied') : t('overlay.copyTextWithHotkey')}
                aria-keyshortcuts="Control+C"
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${copied
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-white/10 bg-white/10 text-white/90 hover:bg-white/20'
                  }`}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={handleDismissCard}
                title={t('window.close')}
                aria-label={t('overlay.dismissAria')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-4 flex-1 overflow-hidden rounded-lg px-3 py-3" style={{ background: 'var(--overlay-surface)' }}>
            <p className="max-h-[108px] overflow-auto pr-1 text-sm leading-6 select-text">
              {fallbackText || t('overlay.noText')}
            </p>
          </div>
        </div>
      ) : state === 'failure' ? (
        <div
          data-overlay-content
          className="pointer-events-auto relative grid w-full max-w-[480px] grid-cols-[auto_1fr] items-start gap-x-2 rounded-xl border px-4 py-4"
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
          <span className="min-w-0 pr-9 text-sm font-medium leading-5">
            {failureTitle || t('overlay.genericError')}
          </span>
          <button
            type="button"
            onClick={handleDismissCard}
            title={t('window.close')}
            aria-label={t('overlay.dismissAria')}
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          {failureDetail && (
            <span
              className="col-start-2 mt-1 pr-9 text-xs leading-5 select-text"
              style={{ color: 'var(--overlay-text-muted)', textWrap: 'pretty' }}
            >
              {failureDetail}
            </span>
          )}
          {failureRecovery !== 'unknown' && (
            <span
              className="col-start-2 mt-2 text-xs leading-5"
              style={{ color: 'var(--overlay-text-muted)', textWrap: 'pretty' }}
            >
              {failureRecovery === 'history'
                ? t('overlay.failureRecoverFromHistory')
                : t('overlay.failureNoRecording')}
            </span>
          )}
        </div>
      ) : (
        <div
          data-overlay-content
          className="flex flex-col items-center gap-2"
        >
          {showMicSourceHint && (
            <div
              className="pointer-events-none flex min-w-0 max-w-[calc(100vw-16px)] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-3 py-1.5 font-normal"
              style={{
                background: 'rgba(11, 11, 12, 0.94)',
                color: 'var(--overlay-text)',
                borderColor: 'var(--overlay-border)',
                boxShadow: '0 2px 10px rgba(0, 0, 0, 0.2)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <MicVocal
                className="h-3.5 w-3.5 shrink-0"
                strokeWidth={1.8}
                style={{ color: '#ffffff' }}
                aria-hidden
              />
              <span className="min-w-0 truncate text-xs font-normal" style={{ color: '#ffffff' }}>
                {micSourceLabel}
              </span>
            </div>
          )}
          <div
            className={`relative flex max-w-[calc(100vw-8px)] items-center overflow-hidden whitespace-nowrap rounded-full px-4 py-2${recordingPhase && recordingVisualPhase === 'preparing' ? ' overlay-pill-recording-waiting' : ''}${recordingPhase && recordingVisualPhase === 'listening' ? ' overlay-pill-recording-listening' : ''}`}
            style={{ minHeight: '38px' }}
          >
            <span
              key={presentationId}
              aria-hidden
              className="overlay-pill-surface overlay-pill-surface-enter absolute inset-0 rounded-full border"
              style={{
                background: 'var(--overlay-bg)',
                borderColor: 'var(--overlay-border)',
              }}
            />
            {recordingPhase ? (
              <div
                className="overlay-recording-stage relative z-[1] min-w-0"
                style={{ color: 'var(--overlay-text)' }}
              >
                <div className="overlay-preparing-indicator" aria-hidden>
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className="overlay-preparing-dot rounded-full"
                      style={{ animationDelay: `${index * 110}ms` }}
                    />
                  ))}
                </div>
                <div
                  className="overlay-recording-content flex min-w-0 items-center"
                  aria-hidden={recordingVisualPhase !== 'listening'}
                >
                  {warning && warningTone === 'error' ? (
                    <div
                      className="flex items-center whitespace-nowrap px-1 text-xs font-semibold text-red-500 animate-pulse"
                      style={{ height: '20px' }}
                    >
                      {warning}
                    </div>
                  ) : (
                    <>
                      <div className="flex min-w-0 items-center gap-[2px] overflow-hidden" style={{ height: '20px' }}>
                        {visibleBars.map((height, index) => {
                          const color = getListeningBarColor(index, normalizedBars.length, theme)
                          return (
                            <div
                              key={index}
                              className="w-[2.5px] rounded-full"
                              style={{
                                backgroundColor: color,
                                boxShadow: 'none',
                                height: `${Math.min(18, Math.max(3, height))}px`,
                                opacity: 0.7 + (Math.min(18, height) / 18) * 0.3,
                                transition: 'height 50ms ease-out, opacity 50ms ease-out',
                              }}
                            />
                          )
                        })}
                      </div>
                      {showDuration && (
                        <span
                          className={`ml-1.5 shrink-0 whitespace-nowrap text-right font-mono tabular-nums text-xs${inCountdown ? ' font-semibold' : ''}${urgent ? ' animate-pulse' : ''}`}
                          style={{ color: timerColor }}
                        >
                          {timerText}
                        </span>
                      )}
                      {warning && (
                        <span className="ml-2 shrink-0 whitespace-nowrap text-xs text-amber-400 animate-pulse">
                          {warning}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="relative z-[1] flex min-w-0 items-center" style={{ color: 'var(--overlay-text)' }}>
                {state === 'thinking' && (
                  <div className="flex items-center gap-2">
                    <div className="relative h-1 w-12 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="absolute left-0 top-0 h-full rounded-full"
                        style={{
                          backgroundColor: thinkingColor,
                          width: '100%',
                          transformOrigin: 'left',
                          animation: `progress-fill ${thinkingDuration}s cubic-bezier(0.4, 0, 0.2, 1) forwards`,
                        }}
                      />
                    </div>
                    <span className="text-xs whitespace-nowrap" style={{ color: thinkingColor }}>
                      {thinkingNote === 'late' ? t('overlay.awaitingLateResult') : t('overlay.processing')}
                    </span>
                  </div>
                )}

                {state === 'error' && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-400">{errorMessage || t('overlay.genericError')}</span>
                  </div>
                )}

                {state === 'toast' && (
                  <div className="flex items-center gap-2">
                    {toastTone === 'warn' ? (
                      <span className="whitespace-nowrap text-xs text-amber-400">{toastText}</span>
                    ) : (
                      <span className="whitespace-nowrap text-xs" style={{ color: 'var(--overlay-text)' }}>
                        {toastText}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
