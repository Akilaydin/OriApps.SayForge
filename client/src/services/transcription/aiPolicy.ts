//
//

import { addRuntimeEvent, AI_EVENT_OUTCOME, AI_LOG_SOURCE } from '../debugLog'
import type { AiExecutionSource, AiExecutionStatus, WorkMode } from './types'

export type AiRoute
  = | 'managed'
  | 'custom'
  | 'integrated_asr'
  | 'none'

export type AiReason
  = | 'ai_off'
  | 'duration_below_min'
  | 'empty_asr'
  | 'integrated_asr'
  | 'config_incomplete'
  | 'call_failed'
  | 'call_timeout'
  | 'empty_output'
  | 'no_evidence'

export interface AiConfigSnapshot {
  workMode: WorkMode
  aiEnabled: boolean
  aiMinDurationSec: number
  serverAiSource: 'managed' | 'custom'
}

export interface AiPolicyInput extends AiConfigSnapshot {
  audioDurationSec: number
  integratedAsr?: boolean
}

export interface AiPolicy {
  route: AiRoute
  allowCall: boolean
  reason?: AiReason
  aiEnabled: boolean
  workMode: WorkMode
  audioMs: number
  minAudioMs: number
}

function toMs(sec: number): number {
  const value = Number(sec)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0
}

export function resolveAiPolicy(input: AiPolicyInput): AiPolicy {
  const audioMs = toMs(input.audioDurationSec)
  const minAudioMs = toMs(input.aiMinDurationSec)
  const base = {
    aiEnabled: input.aiEnabled,
    workMode: input.workMode,
    audioMs,
    minAudioMs,
  }

  if (!input.aiEnabled) {
    return { ...base, route: 'none', allowCall: false, reason: 'ai_off' }
  }

  const route: AiRoute = input.integratedAsr
    ? 'integrated_asr'
    : input.workMode === 'server' && input.serverAiSource === 'managed'
      ? 'managed'
      : 'custom'

  if (input.integratedAsr) {
    return { ...base, route, allowCall: false, reason: 'integrated_asr' }
  }
  if (minAudioMs > 0 && audioMs < minAudioMs) {
    return { ...base, route, allowCall: false, reason: 'duration_below_min' }
  }
  return { ...base, route, allowCall: true }
}

export interface AiEvidence {
  asrTextEmpty?: boolean
  configComplete?: boolean
  serverError?: string
  serverProvider?: string
  clientFailure?: 'timeout' | 'error'
  clientOutputEmpty?: boolean
  llmMs?: number
  provider?: string
  model?: string
}

export interface AiOutcome {
  source: AiExecutionSource
  status: AiExecutionStatus
  reason?: AiReason
  attempted: boolean
  llmMs: number
  provider?: string
  model?: string
}

const NOT_ATTEMPTED = { attempted: false, llmMs: 0 } as const

export function resolveAiOutcome(policy: AiPolicy, evidence: AiEvidence = {}): AiOutcome {
  if (evidence.asrTextEmpty) {
    return { ...NOT_ATTEMPTED, source: 'none', status: 'skipped', reason: 'empty_asr' }
  }

  if (!policy.allowCall) {
    return { ...NOT_ATTEMPTED, source: 'none', status: 'skipped', reason: policy.reason }
  }

  if (policy.route === 'managed') {
    if (evidence.serverError) {
      return {
        source: 'server',
        status: 'failed',
        reason: 'call_failed',
        attempted: true,
        llmMs: evidence.llmMs ?? 0,
        provider: 'server',
      }
    }
    if (evidence.serverProvider || (evidence.llmMs ?? 0) > 0) {
      return {
        source: 'server',
        status: 'applied',
        attempted: true,
        llmMs: evidence.llmMs ?? 0,
        provider: 'server',
        model: evidence.model,
      }
    }
    return {
      source: 'server',
      status: 'unavailable',
      reason: 'no_evidence',
      attempted: false,
      llmMs: 0,
      provider: 'server',
    }
  }

  // route === 'custom'
  if (evidence.configComplete === false) {
    return {
      ...NOT_ATTEMPTED,
      source: 'custom',
      status: 'unavailable',
      reason: 'config_incomplete',
      provider: evidence.provider,
      model: evidence.model,
    }
  }
  if (evidence.clientFailure) {
    return {
      source: 'custom',
      status: 'failed',
      reason: evidence.clientFailure === 'timeout' ? 'call_timeout' : 'call_failed',
      attempted: true,
      llmMs: evidence.llmMs ?? 0,
      provider: evidence.provider,
      model: evidence.model,
    }
  }
  if (evidence.clientOutputEmpty) {
    return {
      source: 'custom',
      status: 'failed',
      reason: 'empty_output',
      attempted: true,
      llmMs: evidence.llmMs ?? 0,
      provider: evidence.provider,
      model: evidence.model,
    }
  }
  return {
    source: 'custom',
    status: 'applied',
    attempted: true,
    llmMs: evidence.llmMs ?? 0,
    provider: evidence.provider,
    model: evidence.model,
  }
}

export function policyFromSnapshot(
  snapshot: AiConfigSnapshot | undefined,
  fallbackWorkMode: WorkMode,
  audioDurationSec: number,
  integratedAsr = false,
): AiPolicy {
  return resolveAiPolicy({
    workMode: snapshot?.workMode ?? fallbackWorkMode,
    aiEnabled: snapshot?.aiEnabled ?? true,
    aiMinDurationSec: snapshot?.aiMinDurationSec ?? 0,
    serverAiSource: snapshot?.serverAiSource ?? 'managed',
    audioDurationSec,
    integratedAsr,
  })
}

export interface AiOutcomeContext {
  operationId: string
  trigger: 'live' | 'history_reprocess'
  serverRef?: string
}

const loggedOutcomes = new Set<string>()
const MAX_LOGGED_OUTCOMES = 200

function markLogged(operationId: string): boolean {
  if (loggedOutcomes.has(operationId)) return false
  if (loggedOutcomes.size >= MAX_LOGGED_OUTCOMES) {
    const oldest = loggedOutcomes.values().next().value
    if (oldest !== undefined) loggedOutcomes.delete(oldest)
  }
  loggedOutcomes.add(operationId)
  return true
}

export function __resetAiOutcomeLogDedupe(): void {
  loggedOutcomes.clear()
}

export function resolveAndLogAiOutcome(
  context: AiOutcomeContext,
  policy: AiPolicy,
  evidence: AiEvidence = {},
): AiOutcome {
  const outcome = resolveAiOutcome(policy, evidence)
  if (markLogged(context.operationId)) {
    addRuntimeEvent('info', AI_LOG_SOURCE, AI_EVENT_OUTCOME, {
      operationId: context.operationId,
      trigger: context.trigger,
      ...(context.serverRef && { serverRef: context.serverRef }),
      workMode: policy.workMode,
      aiEnabled: policy.aiEnabled,
      route: policy.route,
      audioMs: policy.audioMs,
      minAudioMs: policy.minAudioMs,
      status: outcome.status,
      ...(outcome.reason && { reason: outcome.reason }),
      attempted: outcome.attempted,
      llmMs: outcome.llmMs,
      ...(outcome.provider && { provider: outcome.provider }),
      ...(outcome.model && { model: outcome.model }),
    })
  }
  return outcome
}

export function extractServerAiEvidence(
  llmDebug: unknown,
): { error?: string; provider?: string } | undefined {
  if (!llmDebug || typeof llmDebug !== 'object') return undefined
  const source = llmDebug as Record<string, unknown>
  const error = typeof source.error === 'string' && source.error ? source.error : undefined
  const provider = typeof source.provider === 'string' && source.provider ? source.provider : undefined
  if (!error && !provider) return undefined
  return { ...(error && { error }), ...(provider && { provider }) }
}

export function serverShouldPolish(policy: AiPolicy): boolean {
  return policy.allowCall && policy.route === 'managed'
}
