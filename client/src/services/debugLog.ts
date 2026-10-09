export interface RuntimeEvent {
  time: number
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  detail?: unknown
}

const MAX_RUNTIME_EVENTS = 120
const ENABLE_INFO_CONSOLE = false

const RECORDER_KEY_EVENT = /(Recording started|Recording stopped|Entered processing|Final result received|External text insertion succeeded|External text insertion failed|Processing timed out|Showing fallback card)/i
const WEBSOCKET_KEY_EVENT = /(Connection closed|Connection timed out|Failed to send start|Failed to send stop|Connecting|Connected|Reconnected|Ready received|disconnect)/i
const AUDIO_KEY_EVENT = /(Microphone capture started|AudioContext|First PCM frame received|First RMS received|ScriptProcessorNode fallback activated|Capture stop summary)/i
const INSERTION_EVENT = /(Paste decision|External text insertion|fallback|Target is SayForge|Target is not editable)/i

export const AI_LOG_SOURCE = 'ai'
export const AI_EVENT_REQUEST = 'ai.request'
export const AI_EVENT_OUTCOME = 'ai.outcome'
const AI_KEY_EVENTS = new Set<string>([AI_EVENT_REQUEST, AI_EVENT_OUTCOME])

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
      || source === AI_LOG_SOURCE && AI_KEY_EVENTS.has(message)
      || source === 'backend'
      || source === 'update'
  }

  return false
}

function shouldKeepRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.level === 'error' || event.level === 'warn') return true
  if (event.source === 'backend') return true
  if (event.source === AI_LOG_SOURCE) return AI_KEY_EVENTS.has(event.message)
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

export function getRuntimeEvents(): RuntimeEvent[] {
  return runtimeEvents
}

export function clearRuntimeEvents() {
  runtimeEvents = []
}
