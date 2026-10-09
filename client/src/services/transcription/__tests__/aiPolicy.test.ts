import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: mocks.addRuntimeEvent,
  AI_LOG_SOURCE: 'ai',
  AI_EVENT_REQUEST: 'ai.request',
  AI_EVENT_OUTCOME: 'ai.outcome',
}))

import {
  __resetAiOutcomeLogDedupe,
  policyFromSnapshot,
  resolveAiOutcome,
  resolveAiPolicy,
  resolveAndLogAiOutcome,
  type AiConfigSnapshot,
} from '../aiPolicy'

const CLOUD: AiConfigSnapshot = {
  workMode: 'cloud_api',
  aiEnabled: true,
  aiMinDurationSec: 0,
}

function policy(over: Partial<Parameters<typeof resolveAiPolicy>[0]> = {}) {
  return resolveAiPolicy({ ...CLOUD, audioDurationSec: 10, ...over })
}

describe('resolveAiPolicy: cloud only', () => {
  it.each(['cloud_api'] as const)('%s uses client AI by default', (workMode) => {
    expect(policy({ workMode })).toMatchObject({ route: 'custom', allowCall: true })
  })
  it('disabled AI overrides the minimum-duration rule', () => {
    expect(policy({ aiEnabled: false, aiMinDurationSec: 60, audioDurationSec: 4.8 }))
      .toMatchObject({ route: 'none', allowCall: false, reason: 'ai_off' })
  })
  it('preserves the reason and route when speech is below the minimum', () => {
    expect(policy({ aiMinDurationSec: 60, audioDurationSec: 4.8 }))
      .toMatchObject({ route: 'custom', allowCall: false, reason: 'duration_below_min', audioMs: 4800, minAudioMs: 60000 })
  })
  it('allows AI when speech meets the minimum, with 0 meaning no minimum', () => {
    expect(policy({ aiMinDurationSec: 2, audioDurationSec: 2 }).allowCall).toBe(true)
    expect(policy({ aiMinDurationSec: 2, audioDurationSec: 1.999 }).allowCall).toBe(false)
    expect(policy({ aiMinDurationSec: 0, audioDurationSec: 0.2 }).allowCall).toBe(true)
  })
  it('skips separate AI when the ASR model has built-in cleanup', () => {
    expect(policy({ integratedAsr: true }))
      .toMatchObject({ route: 'integrated_asr', allowCall: false, reason: 'integrated_asr' })
  })
})

describe('resolveAiOutcome: client AI evidence', () => {
  it('prioritizes empty ASR input over other skip reasons', () => {
    expect(resolveAiOutcome(policy({ aiEnabled: false }), { asrTextEmpty: true }))
      .toMatchObject({ source: 'none', status: 'skipped', reason: 'empty_asr', attempted: false })
  })
  it('propagates the policy reason for skipped calls', () => {
    expect(resolveAiOutcome(policy({ aiMinDurationSec: 60, audioDurationSec: 1 })))
      .toMatchObject({ status: 'skipped', reason: 'duration_below_min', attempted: false, llmMs: 0 })
  })
  it('reports incomplete provider settings without attempting a call', () => {
    expect(resolveAiOutcome(policy(), { configComplete: false, provider: 'openai_compat' }))
      .toMatchObject({ source: 'custom', status: 'unavailable', reason: 'config_incomplete', attempted: false })
  })
  it('distinguishes errors, timeouts and empty responses', () => {
    expect(resolveAiOutcome(policy(), { clientFailure: 'timeout' }).reason).toBe('call_timeout')
    expect(resolveAiOutcome(policy(), { clientFailure: 'error' }).reason).toBe('call_failed')
    expect(resolveAiOutcome(policy(), { clientOutputEmpty: true }).reason).toBe('empty_output')
    expect(resolveAiOutcome(policy(), { clientFailure: 'error' }).attempted).toBe(true)
  })
  it('reports successful cleanup even if output text is unchanged', () => {
    expect(resolveAiOutcome(policy(), { llmMs: 680, provider: 'openai_compat', model: 'gemini' }))
      .toMatchObject({ source: 'custom', status: 'applied', attempted: true, provider: 'openai_compat', model: 'gemini' })
  })
})

describe('policyFromSnapshot', () => {
  it('keeps the per-record duration policy independent of later settings', () => {
    const p = policyFromSnapshot({ workMode: 'cloud_api', aiEnabled: true, aiMinDurationSec: 60 }, 'cloud_api', 4.8)
    expect(p).toMatchObject({ workMode: 'cloud_api', route: 'custom', allowCall: false, reason: 'duration_below_min' })
  })
  it('defaults missing snapshots to enabled client AI without a minimum', () => {
    expect(policyFromSnapshot(undefined, 'cloud_api', 1)).toMatchObject({ route: 'custom', allowCall: true })
  })
})

describe('resolveAndLogAiOutcome', () => {
  beforeEach(() => {
    mocks.addRuntimeEvent.mockClear()
    __resetAiOutcomeLogDedupe()
  })
  const ctx = { operationId: 'op-1', trigger: 'live' as const }
  it('logs a single outcome with meaningful, privacy-safe fields', () => {
    resolveAndLogAiOutcome(ctx, policy({ aiMinDurationSec: 60, audioDurationSec: 4.8 }))
    const [level, source, message, details] = mocks.addRuntimeEvent.mock.calls[0]
    expect([level, source, message]).toEqual(['info', 'ai', 'ai.outcome'])
    expect(details).toMatchObject({
      operationId: 'op-1', workMode: 'cloud_api', route: 'custom',
      status: 'skipped', reason: 'duration_below_min', attempted: false,
      audioMs: 4800, minAudioMs: 60000,
    })
    for (const forbidden of ['asrText', 'llmText', 'text', 'messages', 'systemPrompt']) {
      expect(Object.keys(details)).not.toContain(forbidden)
    }
  })
  it('deduplicates by operationId and allows separate operations', () => {
    resolveAndLogAiOutcome(ctx, policy())
    resolveAndLogAiOutcome(ctx, policy())
    resolveAndLogAiOutcome({ ...ctx, operationId: 'op-2' }, policy())
    expect(mocks.addRuntimeEvent).toHaveBeenCalledTimes(2)
  })
})
