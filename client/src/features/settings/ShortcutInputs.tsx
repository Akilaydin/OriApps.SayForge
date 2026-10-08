import * as bridge from '@/services/bridge'
import { setShortcutCaptureActive } from '@/services/webviewKeyboardFallback'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { t } from '@/i18n'
import {
  displayAccelerator,
  getSingleKeyDisplay,
  keyEventToShortcutCandidate,
  resolveSingleKeyShortcut,
} from './utils'
import {
  canonicalizePTTShortcut,
  displayPTTShortcut,
  getAcceleratorShortcutValidationError,
  getPTTShortcutWarning,
  getPTTShortcutValidationError,
} from '@/lib/shortcutKeys'

export type ShortcutValidate = (value: string) => Promise<string | null>

const ERROR_VISIBLE_MS = 6000

function useTransientMessage() {
  const [message, setMessage] = useState('')
  const timerRef = useRef<number | undefined>(undefined)
  const show = useCallback((next: string) => {
    window.clearTimeout(timerRef.current)
    setMessage(next)
    if (next) timerRef.current = window.setTimeout(() => setMessage(''), ERROR_VISIBLE_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(timerRef.current), [])
  return [message, show] as const
}

let suspendCount = 0
let activeCaptureCancel: (() => void) | null = null

function isShortcutCaptureOwner(cancel: () => void) {
  return activeCaptureCancel === cancel
}

function useSuspendHotkeys(active: boolean, cancel: () => void) {
  useEffect(() => {
    if (!active) return
    if (activeCaptureCancel && activeCaptureCancel !== cancel) {
      activeCaptureCancel()
    }
    activeCaptureCancel = cancel

    suspendCount += 1
    if (suspendCount === 1) {
      setShortcutCaptureActive(true)
      bridge.beginShortcutCapture()
    }
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      if (activeCaptureCancel === cancel) activeCaptureCancel = null
      suspendCount -= 1
      if (suspendCount === 0) {
        setShortcutCaptureActive(false)
        bridge.endShortcutCapture()
      }
    }
  }, [active, cancel])
}

export function PTTShortcutInput({
  value,
  onChange,
  label,
  description,
  validate,
}: {
  value: string
  onChange: (value: string) => void
  label: ReactNode
  description: string
  validate?: ShortcutValidate
}) {
  const [recording, setRecording] = useState(false)
  const [tempValue, setTempValue] = useState('')
  const [validateError, showValidateError] = useTransientMessage()
  const [showMiddleHint, setShowMiddleHint] = useState(false)
  const pressedRef = useRef(new Set<string>())
  const peakRef = useRef(new Set<string>())
  const committingRef = useRef(false)

  const resetCapture = useCallback(() => {
    pressedRef.current.clear()
    peakRef.current.clear()
    committingRef.current = false
    setTempValue('')
  }, [])

  const cancelRecording = useCallback(() => {
    setRecording(false)
    resetCapture()
  }, [resetCapture])
  useSuspendHotkeys(recording, cancelRecording)

  const commit = useCallback(async (mapped: string) => {
    const canonical = canonicalizePTTShortcut(mapped)
    const formatError = getPTTShortcutValidationError(canonical)
    if (formatError) {
      showValidateError(formatError)
      return false
    }
    const error = validate ? await validate(canonical) : null
    if (error) {
      showValidateError(error)
      return false
    }
    showValidateError('')
    onChange(canonical)
    return true
  }, [onChange, validate, showValidateError])

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!isShortcutCaptureOwner(cancelRecording)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || committingRef.current || pressedRef.current.has(event.code)) return

    pressedRef.current.add(event.code)
    peakRef.current.add(event.code)
    setTempValue(canonicalizePTTShortcut(peakRef.current))
  }, [cancelRecording])

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    if (!isShortcutCaptureOwner(cancelRecording)) return
    event.preventDefault()
    event.stopPropagation()
    if (!pressedRef.current.delete(event.code) || committingRef.current) return

    committingRef.current = true
    const candidate = canonicalizePTTShortcut(peakRef.current)
    setRecording(false)
    void commit(candidate).finally(resetCapture)
  }, [cancelRecording, commit, resetCapture])

  useEffect(() => {
    if (!recording) return
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    const off = bridge.onMouseShortcutCaptured(({ setting }) => {
      if (!isShortcutCaptureOwner(cancelRecording)) return
      if (!setting || committingRef.current) return
      committingRef.current = true
      setRecording(false)
      pressedRef.current.clear()
      peakRef.current.clear()
      setTempValue('')
      window.setTimeout(() => {
        void commit(setting).then((ok) => setShowMiddleHint(ok && setting === 'MButton'))
          .finally(() => { committingRef.current = false })
      }, 400)
    })
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      off()
    }
  }, [recording, handleKeyDown, handleKeyUp, cancelRecording, commit])

  const displayValue = tempValue || value
  const keys = displayValue ? displayPTTShortcut(displayValue) : [t('shortcut.notSet')]
  const shortcutWarning = !recording ? getPTTShortcutWarning(value) : null

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => {
              showValidateError('')
              if (recording) {
                cancelRecording()
              } else {
                resetCapture()
                setRecording(true)
              }
            }}
            className={`flex items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-1.5 text-sm transition-colors ${recording
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-input bg-muted hover:bg-accent'
              }`}
          >
            {recording && !tempValue ? (
              <span className="animate-pulse text-muted-foreground">{t('shortcutInput.pressKeys')}</span>
            ) : (
              keys.map((key, index) => (
                <span key={`${key}-${index}`}>
                  {index > 0 && <span className="mx-0.5 text-muted-foreground">+</span>}
                  <span className={`rounded border bg-card px-1.5 py-0.5 text-xs shadow-sm ${!displayValue ? 'text-muted-foreground' : ''}`}>
                    {key}
                  </span>
                </span>
              ))
            )}
          </button>

          {!recording && value && (
            <button
              onClick={() => onChange('')}
              className="rounded p-1 hover:bg-accent"
              title={t('shortcutInput.clear')}
              aria-label={t('shortcutInput.clear')}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>
      {validateError && (
        <p className="mt-1.5 text-xs text-destructive">{validateError}</p>
      )}
      {shortcutWarning && (
        <p className="mt-1.5 text-xs text-amber-500">{shortcutWarning}</p>
      )}
      {showMiddleHint && value === 'MButton' && (
        <p className="mt-1.5 text-xs text-amber-500">
          {t('shortcutInput.middleMouseWarning')}
        </p>
      )}
    </div>
  )
}

export async function checkShortcutBeforeCommit(
  value: string,
  validate?: ShortcutValidate,
): Promise<string | null> {
  const systemError = getAcceleratorShortcutValidationError(value)
  if (systemError) return systemError
  const error = validate ? await validate(value) : null
  if (error) return error
  const isSingleKey = resolveSingleKeyShortcut(value) !== undefined
  if (!isSingleKey && !(await bridge.testShortcut(value))) {
    return t('shortcutInput.conflictOther')
  }
  return null
}

export function ComboShortcutInput({
  value,
  onChange,
  label,
  description,
  comboOnly = false,
  allowMouseShortcut = false,
  allowClear = true,
  validate,
}: {
  value: string
  onChange: (value: string) => void
  label: ReactNode
  description: string
  comboOnly?: boolean
  allowMouseShortcut?: boolean
  allowClear?: boolean
  validate?: ShortcutValidate
}) {
  const [recording, setRecording] = useState(false)
  const [tempValue, setTempValue] = useState('')
  const [conflict, showConflict] = useTransientMessage()
  const [showMiddleHint, setShowMiddleHint] = useState(false)
  const committingRef = useRef(false)

  const cancelRecording = useCallback(() => { setRecording(false); setTempValue('') }, [])
  useSuspendHotkeys(recording, cancelRecording)

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!isShortcutCaptureOwner(cancelRecording)) return
    event.preventDefault()
    event.stopPropagation()

    const candidate = keyEventToShortcutCandidate(event, { comboOnly })
    if (candidate) setTempValue(candidate)
  }, [cancelRecording, comboOnly])

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    if (!isShortcutCaptureOwner(cancelRecording)) return
    event.preventDefault()
    event.stopPropagation()
    if (!tempValue || committingRef.current) return

    if (comboOnly && resolveSingleKeyShortcut(tempValue) !== undefined) return

    committingRef.current = true
    void (async () => {
      const error = await checkShortcutBeforeCommit(tempValue, validate)
      if (error) {
        showConflict(error)
      } else {
        showConflict('')
        onChange(tempValue)
      }
      setRecording(false)
      setTempValue('')
    })()
  }, [cancelRecording, tempValue, onChange, comboOnly, validate, showConflict])

  useEffect(() => {
    if (!recording) return

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    let off: (() => void) | undefined
    if (!comboOnly || allowMouseShortcut) {
      off = bridge.onMouseShortcutCaptured(({ setting }) => {
        if (!isShortcutCaptureOwner(cancelRecording)) return
        if (!setting || committingRef.current) return
        committingRef.current = true
        setRecording(false)
        setTempValue('')
        window.setTimeout(() => {
          void (async () => {
            const error = await checkShortcutBeforeCommit(setting, validate)
            if (error) {
              showConflict(error)
              return
            }
            showConflict('')
            setShowMiddleHint(setting === 'MButton')
            onChange(setting)
          })()
        }, 400)
      })
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      off?.()
    }
  }, [recording, handleKeyDown, handleKeyUp, comboOnly, allowMouseShortcut, cancelRecording, onChange, validate, showConflict])

  const isSingleKey = resolveSingleKeyShortcut(tempValue || value) !== undefined
  const displayValue = tempValue || value || ''
  const keys = !displayValue
    ? [t('shortcut.notSet')]
    : isSingleKey
      ? [getSingleKeyDisplay(displayValue)]
      : displayAccelerator(displayValue)

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => {
              committingRef.current = false
              setRecording(!recording)
              setTempValue('')
              showConflict('')
            }}
            className={`flex items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-1.5 text-sm transition-colors ${recording
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-input bg-muted hover:bg-accent'
              }`}
          >
            {recording && !tempValue ? (
              <span className="animate-pulse text-muted-foreground">{t('shortcutInput.pressKeys')}</span>
            ) : (
              keys.map((key, index) => (
                <span key={index}>
                  {index > 0 && <span className="mx-0.5 text-muted-foreground">+</span>}
                  <span className="rounded border bg-card px-1.5 py-0.5 text-xs shadow-sm">{key}</span>
                </span>
              ))
            )}
          </button>

          {allowClear && !recording && (
            <button
              onClick={() => onChange('')}
              className="rounded p-1 hover:bg-accent"
              aria-label={t('shortcutInput.clear')}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>
      {conflict && (
        <p className="mt-1.5 text-xs text-destructive">{conflict}</p>
      )}
      {showMiddleHint && value === 'MButton' && (
        <p className="mt-1.5 text-xs text-amber-500">{t('shortcutInput.middleMouseWarning')}</p>
      )}
    </div>
  )
}
