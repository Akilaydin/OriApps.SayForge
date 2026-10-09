
const ASR_DISPLAY_MODEL_MAP: Record<string, string> = {
  groq_whisper: 'whisper-large-v3-turbo',
  openai_transcribe: 'gpt-transcribe',
  openai_live_transcribe: 'gpt-live-transcribe',
  gemini_transcribe: 'gemini-3.5-transcribe',
  gemini_live_transcribe: 'gemini-3.5-transcribe-live',
  openrouter_transcribe: 'openai/gpt-transcribe',
}

export function resolveAsrDisplayModel(providerKey: string, selectedModel?: string): string {
  const picked = selectedModel?.trim()
  if (picked) return picked
  return ASR_DISPLAY_MODEL_MAP[providerKey] || providerKey || 'unknown'
}

export interface AsrConfigExtra extends Record<string, unknown> {
  model?: string
  instructions?: string
  userPrompt?: string
  audioEncoding?: string
  baseUrl?: string
  protocol?: string
}

export function buildAsrExtra(
  provider: string,
  options: {
    model?: string
    instructions?: string
    userPrompt?: string
    audioEncoding?: string
    baseUrl?: string
    protocol?: string
  } = {},
): AsrConfigExtra | undefined {
  const model = options.model?.trim() || ''
  const instructions = options.instructions?.trim() ?? ''
  const userPrompt = options.userPrompt?.trim() ?? ''
  const audioEncoding = options.audioEncoding === 'mp3' ? 'mp3' : ''
  const baseUrl = options.baseUrl?.trim() ?? ''
  const protocol = options.protocol?.trim() ?? ''
  const explicitProtocol = protocol === 'auto' ? '' : protocol
  if (!model && !instructions && !userPrompt && !audioEncoding && !baseUrl && !explicitProtocol) return undefined
  return {
    ...(model ? { model } : {}),
    ...(instructions ? { instructions } : {}),
    ...(userPrompt ? { userPrompt } : {}),
    ...(audioEncoding ? { audioEncoding } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(explicitProtocol ? { protocol: explicitProtocol } : {}),
  }
}

const STREAMING_CAPABLE = new Set([
  'openai_live_transcribe',
  'gemini_live_transcribe',
])

export function isStreamingDisplayCapable(provider: string): boolean {
  return STREAMING_CAPABLE.has(provider)
}

export function isStreamingDisplayReady(provider: string): boolean {
  return isStreamingDisplayCapable(provider)
}

//

export type HotwordDelivery =
  | 'vocabulary'
  | 'context'
  | 'instruction'
  | 'protocol_has_no_slot'
  | 'not_wired_up'
  | 'undecided_protocol'
  | 'unknown_provider'

export interface AsrHotwordCapability {
  streaming: HotwordDelivery
  buffered: HotwordDelivery
  hasStreamingPath: boolean
  streamingClientCap: number | null
  bufferedClientCap: number | null
}

export type HotwordUiState = 'sent' | 'not_sent' | 'undecided'

export function foldHotwordDelivery(delivery: HotwordDelivery): HotwordUiState {
  switch (delivery) {
    case 'vocabulary':
    case 'context':
    case 'instruction':
      return 'sent'
    case 'undecided_protocol':
      return 'undecided'
    case 'protocol_has_no_slot':
    case 'not_wired_up':
      return 'not_sent'
    case 'unknown_provider':
      return 'undecided'
  }
}

export type HotwordUndecidedReason = 'protocol' | 'declaration_missing' | 'query_failed'

export function hotwordUndecidedReason(delivery: HotwordDelivery): HotwordUndecidedReason | null {
  switch (delivery) {
    case 'undecided_protocol':
      return 'protocol'
    case 'unknown_provider':
      return 'declaration_missing'
    default:
      return null
  }
}

export interface HotwordPathOptions {
  streamingDisplayEnabled: boolean
  provider: string
}

export function willUseStreamingPath(
  capability: AsrHotwordCapability,
  opts: HotwordPathOptions,
): boolean {
  if (!capability.hasStreamingPath) return false
  return opts.streamingDisplayEnabled
    && isStreamingDisplayReady(opts.provider)
}

export function expectedHotwordDelivery(
  capability: AsrHotwordCapability,
  opts: HotwordPathOptions,
): HotwordDelivery {
  return willUseStreamingPath(capability, opts) ? capability.streaming : capability.buffered
}

export function expectedClientCap(
  capability: AsrHotwordCapability,
  opts: HotwordPathOptions,
): number | null {
  return willUseStreamingPath(capability, opts)
    ? capability.streamingClientCap
    : capability.bufferedClientCap
}

export function hotwordDependsOnStreamingPath(capability: AsrHotwordCapability): boolean {
  return capability.hasStreamingPath
    && foldHotwordDelivery(capability.streaming) !== foldHotwordDelivery(capability.buffered)
}
