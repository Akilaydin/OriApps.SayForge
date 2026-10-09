import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appendDebugLog: vi.fn() }))

vi.mock('../bridge', () => ({ appendDebugLog: mocks.appendDebugLog }))

import {
  addRuntimeEvent,
  AI_EVENT_OUTCOME,
  AI_EVENT_REQUEST,
  AI_LOG_SOURCE,
  clearRuntimeEvents,
  getRuntimeEvents,
} from '../debugLog'

interface MirroredPayload {
  kind?: string
  level?: string
  source?: string
  message?: string
  detail?: unknown
}

function mirrored(): MirroredPayload[] {
  return mocks.appendDebugLog.mock.calls.map((call) => call[0] as MirroredPayload)
}

function mirroredMessages(): string[] {
  return mirrored()
    .filter((p) => p.kind === 'runtime')
    .map((p) => p.message ?? '')
}

describe('AI events pass the log persistence filter', () => {
  beforeEach(() => {
    mocks.appendDebugLog.mockClear()
    clearRuntimeEvents()
  })

  it.each([AI_EVENT_OUTCOME, AI_EVENT_REQUEST])('mirrors %s to the main log', (event) => {
    addRuntimeEvent('info', AI_LOG_SOURCE, event, { operationId: 'op-x' })
    expect(mirroredMessages()).toContain(event)
  })

  it.each([AI_EVENT_OUTCOME, AI_EVENT_REQUEST])('retains %s in runtime events', (event) => {
    addRuntimeEvent('info', AI_LOG_SOURCE, event, { operationId: 'op-y' })
    const kept = getRuntimeEvents().filter((e) => e.message === event)
    expect(kept.length).toBeGreaterThan(0)
  })

  it('filters other info events from the same source', () => {
    addRuntimeEvent('info', AI_LOG_SOURCE, 'ai.some.debug.chatter', { noise: true })
    expect(mirroredMessages()).not.toContain('ai.some.debug.chatter')
  })

  it('continues filtering legacy provider-named info events', () => {
    for (const source of ['server', 'local', 'cloud_api', 'history']) {
      addRuntimeEvent('info', source, 'AI cleanup skipped below duration threshold', {})
    }
    expect(mirroredMessages()).not.toContain('AI cleanup skipped below duration threshold')
  })

  it('allows warnings independently of the info allowlist', () => {
    addRuntimeEvent('warn', 'server', 'Custom AI cleanup failed; using raw ASR text', { error: 'boom' })
    expect(mirroredMessages()).toContain('Custom AI cleanup failed; using raw ASR text')
  })
})
