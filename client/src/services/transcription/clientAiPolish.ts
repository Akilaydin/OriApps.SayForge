import { invoke } from '@tauri-apps/api/core'
import { addRuntimeEvent, AI_EVENT_REQUEST, AI_LOG_SOURCE } from '../debugLog'
import { getSetting } from '../store'
import {
  resolveAndLogAiOutcome,
  type AiEvidence,
  type AiOutcomeContext,
  type AiPolicy,
} from './aiPolicy'
import type { AiExecutionSource, AiExecutionStatus, StartOptions } from './types'

interface AiResult {
  text: string
  elapsed_ms: number
}

const CLIENT_AI_TIMEOUT_MS = 8_000

interface ClientAiConfig {
  provider: string
  apiUrl: string
  apiKey: string
  model: string
}

export interface ClientAiPolishResult {
  llmText: string
  llmMs: number
  contextApplied?: boolean
  aiSource: AiExecutionSource
  aiStatus: AiExecutionStatus
  aiProvider?: string
  aiModel?: string
  aiReason?: string
  aiAttempted: boolean
}

interface ClientAiPolishOptions {
  asrText: string
  startOptions?: Readonly<StartOptions>
  policy: AiPolicy
  outcomeContext: AiOutcomeContext
  logSource: string
  isCurrent?: () => boolean
}

async function loadClientAiConfig(): Promise<ClientAiConfig> {
  const [provider, apiUrl, apiKey, model] = await Promise.all([
    getSetting('cloudAi.provider', 'openai_compat') as Promise<string>,
    getSetting('cloudAi.apiUrl', '') as Promise<string>,
    getSetting('cloudAi.apiKey', '') as Promise<string>,
    getSetting('cloudAi.model', '') as Promise<string>,
  ])
  return { provider, apiUrl, apiKey, model }
}

export function isClientAiConfigComplete(config: ClientAiConfig): boolean {
  return Boolean(
    (config.provider === 'openai_compat' || config.provider === 'groq')
    &&
    config.apiUrl.trim()
    && config.model.trim()
    && config.apiKey.trim(),
  )
}

function safeFallbackText(asrText: string, startOptions?: Readonly<StartOptions>): string {
  return startOptions?.textContext?.selectedText || asrText
}

function toResult(
  policy: AiPolicy,
  evidence: AiEvidence,
  options: ClientAiPolishOptions,
  llmText?: string,
): ClientAiPolishResult {
  const outcome = resolveAndLogAiOutcome(options.outcomeContext, policy, evidence)
  const applied = outcome.status === 'applied'
  return {
    llmText: applied && llmText ? llmText : safeFallbackText(options.asrText, options.startOptions),
    llmMs: outcome.llmMs,
    contextApplied: options.startOptions?.textContext ? applied : undefined,
    aiSource: outcome.source,
    aiStatus: outcome.status,
    aiProvider: outcome.provider,
    aiModel: outcome.model,
    aiReason: outcome.reason,
    aiAttempted: outcome.attempted,
  }
}

export async function polishWithClientAi(
  options: ClientAiPolishOptions,
): Promise<ClientAiPolishResult | null> {
  const { asrText, startOptions, policy, logSource } = options
  const isCurrent = options.isCurrent ?? (() => true)

  if (!asrText.trim()) {
    return toResult(policy, { asrTextEmpty: true }, options)
  }

  if (!policy.allowCall) {
    return toResult(policy, {}, options)
  }

  const config = await loadClientAiConfig()
  if (!isCurrent()) return null

  if (!isClientAiConfigComplete(config)) {
    return toResult(policy, {
      configComplete: false,
      provider: config.provider || undefined,
      model: config.model || undefined,
    }, options)
  }

  addRuntimeEvent('info', AI_LOG_SOURCE, AI_EVENT_REQUEST, {
    logSource,
    route: policy.route,
    provider: config.provider,
    model: config.model,
    asrChars: asrText.length,
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const request = invoke<AiResult>('cloud_polish', {
      request: {
        text: asrText,
        ai_config: {
          provider: config.provider,
          api_url: config.apiUrl,
          api_key: config.apiKey,
          model: config.model,
        },
        system_prompt: startOptions?.systemPrompt || null,
        text_context: startOptions?.textContext || null,
      },
    })
    const result = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Custom AI timed out after ${CLIENT_AI_TIMEOUT_MS}ms`)),
          CLIENT_AI_TIMEOUT_MS,
        )
      }),
    ])
    if (!isCurrent()) return null

    const evidence: AiEvidence = {
      llmMs: result.elapsed_ms,
      provider: config.provider,
      model: config.model,
      ...(result.text ? {} : { clientOutputEmpty: true }),
    }
    return toResult(policy, evidence, options, result.text)
  } catch (error) {
    if (!isCurrent()) return null
    const message = String(error)
    const isTimeout = message.includes('timed out')
    addRuntimeEvent('warn', logSource, 'Custom AI cleanup failed; using raw ASR text', {
      error: message,
      provider: config.provider,
      model: config.model,
    })
    return toResult(policy, {
      clientFailure: isTimeout ? 'timeout' : 'error',
      provider: config.provider,
      model: config.model,
    }, options)
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
