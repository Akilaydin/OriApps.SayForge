
const ASR_DISPLAY_MODEL_MAP: Record<string, string> = { openai_compat: 'whisper-1' }

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

export type HotwordDelivery =
  | 'vocabulary'
  | 'context'
  | 'instruction'
  | 'protocol_has_no_slot'
  | 'not_wired_up'
  | 'undecided_protocol'
  | 'unknown_provider'

export interface AsrHotwordCapability {
  buffered: HotwordDelivery
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
