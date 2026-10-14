export interface RuntimeEvent {
  time: number
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  detail?: unknown
}

import { diagnoseFailure } from '@/lib/errorMessages'

const MAX_RUNTIME_EVENTS = 120
const ENABLE_INFO_CONSOLE = false

const RECORDER_KEY_EVENT = /(Recording started|Recording stopped|Entered processing|Final result received|External text insertion succeeded|External text insertion failed|Processing timed out|Showing fallback card)/i
const WEBSOCKET_KEY_EVENT = /(Connection closed|Connection timed out|Failed to send start|Failed to send stop|Connecting|Connected|Reconnected|Ready received|disconnect)/i
const AUDIO_KEY_EVENT = /(Microphone capture started|AudioContext|First PCM frame received|First RMS received|ScriptProcessorNode fallback activated|Capture stop summary)/i
const INSERTION_EVENT = /(Paste decision|External text insertion|fallback|Target is SayForge|Target is not editable)/i


function shouldMirrorPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>

  if (value.kind === 'runtime') {
    const level = value.level
    const source = typeof value.source === 'string' ? value.source : ''
    const message = typeof value.message === 'string' ? value.message : ''

    if (level === 'error' || level === 'warn') return true
    if (level !== 'info') return false

    return source === 'recorder' && RECORDER_KEY_EVENT.test(message)
      || source === 'websocket' && WEBSOCKET_KEY_EVENT.test(message)
      || source === 'audio' && AUDIO_KEY_EVENT.test(message)
      || source === 'backend'
      || source === 'update'
  }

  return false
}

function shouldKeepRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.level === 'error' || event.level === 'warn') return true
  if (event.source === 'backend') return true
  if (event.source === 'update') return true
  if (event.source === 'websocket') {
    return WEBSOCKET_KEY_EVENT.test(event.message)
  }
  if (event.source === 'recorder') {
    return RECORDER_KEY_EVENT.test(event.message)
  }
  if (event.source === 'audio') {
    return AUDIO_KEY_EVENT.test(event.message)
  }
  return false
}

let runtimeEvents: RuntimeEvent[] = []

import { appendDebugLog } from './bridge'

function mirrorToMainLog(payload: unknown) {
  if (!shouldMirrorPayload(payload)) return
  try {
    appendDebugLog(payload)
  } catch {
    // ignore logging errors
  }
}

function pushRuntimeEvent(event: RuntimeEvent) {
  if (!shouldKeepRuntimeEvent(event)) return
  runtimeEvents.unshift(event)
  if (runtimeEvents.length > MAX_RUNTIME_EVENTS) {
    runtimeEvents = runtimeEvents.slice(0, MAX_RUNTIME_EVENTS)
  }
}

export function addRuntimeEvent(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  detail?: unknown,
) {
  // Backend callbacks used to put the full rejected provider string in the
  // message. Retain its categorical cause, never the response body.
  if (source === 'backend' && level === 'error') {
    detail = { error: message, context: detail }
    message = 'Backend operation failed'
  }
  detail = sanitizeDetail(detail)
  const event: RuntimeEvent = {
    time: Date.now(),
    level,
    source,
    message,
    detail,
  }

  pushRuntimeEvent(event)

  const logPrefix = `[${source}] ${message}`
  if (level === 'error') {
    console.error(logPrefix, detail)
  } else if (level === 'warn') {
    console.warn(logPrefix, detail)
  } else if (ENABLE_INFO_CONSOLE) {
    console.log(logPrefix, detail)
  } else if (source === 'recorder' && INSERTION_EVENT.test(message)) {
    // Always log paste-related info events for debugging insertion failures
    console.log(logPrefix, detail)
  }
  mirrorToMainLog({
    kind: 'runtime',
    level,
    source,
    message,
    detail,
    time: event.time,
  })
}

function sanitizeDetail(value: unknown, key = '', seen = new WeakSet<object>(), depth = 0): unknown {
  if (/^(error|exception|msg)$/.test(key) || value instanceof Error) return diagnoseFailure(value)
  if (/api.?key|token|password|secret|authorization|credential|prompt|instruction|endpoint|url|model/i.test(key)) return '[redacted]'
  if (typeof value === 'number' && /(?:Len|Length|Count|Bytes|Ms|Sec)$/i.test(key)) return value
  if (/transcript|(?:asr|llm|result|recognized|editor)[_.]?text|selection|(?:request|response|raw)[_.]?body|^body$|window.?title|^title$|^(?:text|audio|pcm|wav|mp3|base64)$|audio.*(?:data|buffer|base64|b64|chunks)/i.test(key)) return '[redacted]'
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== 'undefined' && value instanceof Blob)) return '[redacted]'
  if (typeof value === 'string') {
    const safe = value.replace(/\b(?:https?|wss?):\/\/\S+/gi, '[url redacted]')
    return safe.length > 500 ? safe.slice(0, 500) + '…' : safe
  }
  if (!value || typeof value !== 'object') return value
  if (depth >= 4 || seen.has(value)) return '[bounded]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDetail(item, key, seen, depth + 1))
    return Object.fromEntries(Object.entries(value).slice(0, 60)
      .map(([name, item]) => [name, sanitizeDetail(item, name, seen, depth + 1)]))
  } catch {
    return '[unavailable]'
  }
}

export function reportRuntimeFailure(source: string, operation: string, error: unknown,
  level: 'warn' | 'error' = 'error') {
  try {
    addRuntimeEvent(level, source, 'Operation failed', { operation, error })
  } catch {
    // Diagnostics must not replace the original operation failure.
  }
}

export function getRuntimeEvents(): RuntimeEvent[] {
  return runtimeEvents
}

export function clearRuntimeEvents() {
  runtimeEvents = []
}
