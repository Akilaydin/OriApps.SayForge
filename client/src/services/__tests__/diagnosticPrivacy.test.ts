import { beforeEach, describe, expect, it, vi } from 'vitest'
const log = vi.hoisted(() => ({ appendDebugLog: vi.fn() }))
vi.mock('../bridge', () => log)
import { addRuntimeEvent, clearRuntimeEvents, getRuntimeEvents } from '../debugLog'

beforeEach(() => { log.appendDebugLog.mockClear(); clearRuntimeEvents() })

describe('persistent diagnostic privacy', () => {
  it('retains actionable failure metadata and counters while excluding private content and binary audio', () => {
    addRuntimeEvent('warn', 'synthetic', 'Synthetic failure', {
      error: new Error('HTTP 403: SYNTHETIC_PRIVATE_RESPONSE token=SYNTHETIC_SECRET'),
      apiKey: 'SYNTHETIC_SECRET', audio_b64: 'SYNTHETIC_AUDIO',
      asrText: 'SYNTHETIC_TRANSCRIPT', responseBody: 'SYNTHETIC_PRIVATE_RESPONSE',
      pcm: new Float32Array([0.321, 0.654]), textLen: 42,
    })
    const payload = log.appendDebugLog.mock.calls[0][0]
    expect(payload.detail.error).toMatchObject({ kind: 'http', httpStatus: 403 })
    expect(payload.detail.textLen).toBe(42)
    expect(typeof payload.detail.pcm).toBe('string')
    for (const value of ['SYNTHETIC_SECRET', 'SYNTHETIC_AUDIO', 'SYNTHETIC_TRANSCRIPT', 'SYNTHETIC_PRIVATE_RESPONSE']) {
      expect(JSON.stringify(payload)).not.toContain(value)
      expect(JSON.stringify(getRuntimeEvents())).not.toContain(value)
    }
  })

  it('bounds cyclic diagnostic context and never leaks backend response text through the event message', () => {
    const context: Record<string, unknown> = {}
    context.self = context
    addRuntimeEvent('error', 'backend', 'sayforge_error:provider_timeout:HTTP 504 SYNTHETIC_PRIVATE_RESPONSE', context)
    const output = JSON.stringify(log.appendDebugLog.mock.calls)
    expect(output).toContain('provider_timeout')
    expect(output).not.toContain('SYNTHETIC_PRIVATE_RESPONSE')
    expect(() => JSON.stringify(getRuntimeEvents())).not.toThrow()
  })
})
