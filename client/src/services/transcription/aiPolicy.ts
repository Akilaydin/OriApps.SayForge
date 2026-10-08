// AI 整理的「策略」与「结果」判据 —— 全模式、全入口唯一一份。
//
// 为什么要单独抽一层：影响「这次会不会被 AI 整理、由谁整理」的有四个设置
// （aiEnabled / aiMinDurationSec / server.aiSource / workMode），它们此前在五处
// 各判一遍（录音器停止段、ServerProvider、clientAiPolish、History 的三条重跑路径），
// 结论已经漂移了：云 API 重跑漏了时长门槛、对 ollama 的配置判据和本地重跑不一致、
// 重跑路径的失败被空 catch 吞掉既无日志也无代次检查。改一处永远漏一处。
//
// 拆成两个函数而不是一个大函数，是因为两件事的已知信息不同：
//   - resolveAiPolicy：松键时就能算（配置 + 音频时长），决定路由和是否允许调用。
//   - resolveAiOutcome：要等执行完（识别是否为空、服务端有没有真跑、调用成功与否）。
// 合成一个会迫使调用方在信息不全时先猜一个结果，再回头改——那正是现在的毛病。

import { addRuntimeEvent, AI_EVENT_OUTCOME, AI_LOG_SOURCE } from '../debugLog'
import type { AiExecutionSource, AiExecutionStatus, WorkMode } from './types'

/**
 * 谁负责这次整理。**独立于「有没有执行」**。
 *
 * `custom` 永远不是跳过原因：服务器模式选自配 AI 时，服务端只是不做整理，客户端会
 * 继续调用（见 ServerProvider.handleCustomFinal）。把它记成跳过会直接把排查带错方向。
 */
export type AiRoute
  = | 'custom' // 客户端调用用户自配的 AI 档案（可能是远程服务，不一定在本机）
  | 'integrated_asr' // 识别引擎自带整理（如 Qwen Omni），不另外调独立 AI
  | 'none' // 总开关关闭

/** 没整理 / 没整理成功的原因。稳定取值，日志与历史共用，不要改字面量。 */
export type AiReason
  = | 'ai_off' // 总开关关闭
  | 'duration_below_min' // 低于短语音门槛
  | 'empty_asr' // 没识别出文本，无可整理
  | 'integrated_asr' // 识别引擎已内置整理
  | 'config_incomplete' // 选了自配 AI 但档案不完整
  | 'call_failed' // 调用发出去了，失败
  | 'call_timeout' // 调用超时
  | 'empty_output' // 调用成功但返回空文本

export interface AiConfigSnapshot {
  workMode: WorkMode
  aiEnabled: boolean
  /** 0 = 不设门槛。 */
  aiMinDurationSec: number
}

export interface AiPolicyInput extends AiConfigSnapshot {
  /**
   * 实际 PCM 时长（秒）。**不要四舍五入，也不要用热键按住时长或界面显示值**：
   * 按住时长含松键前后的空白，界面值是格式化过的，两者都会让「恰好等于门槛」
   * 这一档判错。
   */
  audioDurationSec: number
  /** 识别引擎自带整理（Qwen Omni 一类）。 */
  integratedAsr?: boolean
}

export interface AiPolicy {
  route: AiRoute
  /** 策略是否允许发起调用。false 时 reason 必定有值。 */
  allowCall: boolean
  reason?: AiReason
  aiEnabled: boolean
  workMode: WorkMode
  /** 冻结进日志与历史，供事后解释用：不能拿今天的设置解释昨天的记录。 */
  audioMs: number
  minAudioMs: number
}

function toMs(sec: number): number {
  const value = Number(sec)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0
}

/**
 * 决定路由与是否允许调用。
 *
 * 优先级是刻意的：总开关关闭优先于时长门槛（用户主动关掉 AI 时，报「低于门槛」
 * 会让他去调一个根本不生效的设置）。配置完整性**不在这里判** —— 它属于执行证据，
 * 只有策略已经允许调用之后才有意义，否则 AI 关着也会报「配置不完整」。
 */
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

  // 路由只看配置，与「这次跑不跑」无关。日志里保留它才能回答
  // 「AI 开着但没整理，本来该谁做」。
  const route: AiRoute = input.integratedAsr ? 'integrated_asr' : 'custom'

  if (input.integratedAsr) {
    return { ...base, route, allowCall: false, reason: 'integrated_asr' }
  }
  if (minAudioMs > 0 && audioMs < minAudioMs) {
    return { ...base, route, allowCall: false, reason: 'duration_below_min' }
  }
  return { ...base, route, allowCall: true }
}

/** 执行证据。缺省一律按「不知道」处理，绝不按「失败」处理。 */
export interface AiEvidence {
  /** 识别结果是否为空。空文本时不存在「整理」这件事。 */
  asrTextEmpty?: boolean
  /** 自配 AI 档案是否完整。仅 route=custom 时有意义。 */
  configComplete?: boolean
  /** 自配 AI 的失败种类。 */
  clientFailure?: 'timeout' | 'error'
  /** 自配 AI 调用成功但返回空文本。 */
  clientOutputEmpty?: boolean
  llmMs?: number
  provider?: string
  model?: string
}

export interface AiOutcome {
  source: AiExecutionSource
  status: AiExecutionStatus
  reason?: AiReason
  /** 是否真的向 AI 发出过调用。跳过时必须为 false，用来交叉验证日志。 */
  attempted: boolean
  llmMs: number
  provider?: string
  model?: string
}

const NOT_ATTEMPTED = { attempted: false, llmMs: 0 } as const

/**
 * 由策略 + 执行证据得出最终结果。
 *
 * 刻意不比较文本：AI 整理成功但文本恰好没变化（本来就规范的一句话）是正常结果，
 * 按文本相等判会把它记成没执行。
 */
export function resolveAiOutcome(policy: AiPolicy, evidence: AiEvidence = {}): AiOutcome {
  // 空识别排在最前：没有文本时「为什么没整理」的真答案是「没识别出东西」，
  // 报门槛或总开关都会把人引去查 AI 设置。
  if (evidence.asrTextEmpty) {
    return { ...NOT_ATTEMPTED, source: 'none', status: 'skipped', reason: 'empty_asr' }
  }

  if (!policy.allowCall) {
    return { ...NOT_ATTEMPTED, source: 'none', status: 'skipped', reason: policy.reason }
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

/**
 * 从 start 时冻结的配置快照 + 本次实际时长复原策略。
 *
 * 缓冲型 Provider（本地 / 云 API）的识别在 stop 之后才做，时长由它们自己的 PCM 缓冲
 * 算出，所以策略只能在那时就地算。共用这个入口是为了保证「算的人不同、判据同一份」。
 *
 * 快照缺失时按「AI 开启、无门槛」兜底：宁可多调一次 AI，也不要因为一个可选字段
 * 没传就静默不整理 —— 那正是本轮要消灭的故障形态。
 */
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
    audioDurationSec,
    integratedAsr,
  })
}

export interface AiOutcomeContext {
  /**
   * 本次处理的唯一标识。实时录音用 runId 派生，历史重跑每次新建 —— **不能复用**
   * 被重跑那条记录的旧标识，否则两次处理在日志里分不开。
   */
  operationId: string
  trigger: 'live' | 'history_reprocess'
  /** 服务端连接/会话标识，用来把客户端日志和服务器日志对起来（服务器日志每行有 cid/sid）。 */
  serverRef?: string
}

/**
 * 已落过最终摘要的 operationId。
 *
 * 「每次处理恰好一条 ai.outcome」如果只靠调用方自觉，早晚会在某条分支上漏掉或写两条
 * （asr / final / done 各写一次是最容易发生的）。这里做成结构保证：同一个 operationId
 * 第二次调用直接丢弃。容量有上限，避免长时间运行后无限增长。
 */
const loggedOutcomes = new Set<string>()
const MAX_LOGGED_OUTCOMES = 200

function markLogged(operationId: string): boolean {
  if (loggedOutcomes.has(operationId)) return false
  if (loggedOutcomes.size >= MAX_LOGGED_OUTCOMES) {
    // Set 保持插入序，删最早的那个即可
    const oldest = loggedOutcomes.values().next().value
    if (oldest !== undefined) loggedOutcomes.delete(oldest)
  }
  loggedOutcomes.add(operationId)
  return true
}

/** 仅供测试重置。 */
export function __resetAiOutcomeLogDedupe(): void {
  loggedOutcomes.clear()
}

/**
 * 判定结果并落唯一一条 `ai.outcome`。
 *
 * 所有终结点都必须走这里，不要自己拼日志：这条日志是「为什么没整理」的唯一答案，
 * 分散拼写会让字段在各条路径上不一致，而排查时是按字段 grep 的。
 *
 * 只记长度与结论，不记识别正文、整理正文、prompt 正文。
 */
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
      // route 始终独立于 reason：custom 表示"服务端不做、客户端做"，不是跳过。
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
