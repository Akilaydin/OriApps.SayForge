
import { t } from '@/i18n'

export type ErrorActionHint = 'reset_url' | 'check_key' | 'switch_source' | 'retry' | 'none'

export type FriendlyErrorCode =
  | 'server_timeout'
  | 'server_unreachable'
  | 'server_forbidden'
  | 'server_not_service'
  | 'server_internal'
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_bad_key'
  | 'provider_forbidden'
  | 'provider_rate_limit'
  | 'provider_insufficient_balance'
  | 'provider_no_model'
  | 'download_network'
  | 'download_busy'
  | 'download_source_mismatch'
  | 'download_no_space'
  | 'download_permission'
  | 'download_checksum'
  | 'download_failed'
  | 'connect_failed'

export interface FriendlyError {
  code: FriendlyErrorCode
  message: string
  detail: string
  action: ErrorActionHint
}

const ERROR_PROTOCOL_PREFIX = 'sayforge_error:'

interface DecodedError {
  code: FriendlyErrorCode | null
  text: string
}

const FRIENDLY_ERROR_CODES = new Set<FriendlyErrorCode>([
  'server_timeout',
  'server_unreachable',
  'server_forbidden',
  'server_not_service',
  'server_internal',
  'provider_timeout',
  'provider_unreachable',
  'provider_bad_key',
  'provider_forbidden',
  'provider_rate_limit',
  'provider_insufficient_balance',
  'provider_no_model',
  'download_network',
  'download_busy',
  'download_source_mismatch',
  'download_no_space',
  'download_permission',
  'download_checksum',
  'download_failed',
  'connect_failed',
])

/**
 * Rust/Tauri errors use `sayforge_error:<stable-code>:<diagnostic detail>`.
 * The code is the contract; the detail may change language and remains useful for diagnostics.
 * Unknown codes deliberately fall back to legacy text classification for forward compatibility.
 */
function decodeError(error: unknown): DecodedError {
  const value = error instanceof Error ? (error.message || String(error)) : String(error)
  if (!value.startsWith(ERROR_PROTOCOL_PREFIX)) return { code: null, text: value }

  const separator = value.indexOf(':', ERROR_PROTOCOL_PREFIX.length)
  if (separator < 0) return { code: null, text: value }
  const candidate = value.slice(ERROR_PROTOCOL_PREFIX.length, separator)
  const text = value.slice(separator + 1)
  return FRIENDLY_ERROR_CODES.has(candidate as FriendlyErrorCode)
    ? { code: candidate as FriendlyErrorCode, text }
    : { code: null, text }
}

function extractHttpStatus(text: string): number | null {
  const match = text.match(/\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i)
    || text.match(/\((\d{3})\)/)
  if (!match) return null
  const code = Number(match[1])
  return code >= 100 && code <= 599 ? code : null
}

function isNetworkFailure(text: string): boolean {
  return /failed to fetch|networkerror|error sending request|econnrefused|enotfound|dns|connection refused|unreachable|websocket connection failed/i
    .test(text)
}

function isTimeout(text: string): boolean {
  return /timeout|timed out/i.test(text)
}

export function describeServerError(error: unknown, hasCustomUrl: boolean): FriendlyError {
  const { code: stableCode, text } = decodeError(error)
  const status = extractHttpStatus(text)

  if (stableCode === 'server_timeout' || isTimeout(text)) {
    return {
      code: 'server_timeout',
      message: t('err.server.timeout'),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'server_unreachable' || isNetworkFailure(text)) {
    return {
      code: 'server_unreachable',
      message: t('err.server.unreachable'),
      detail: text,
      action: hasCustomUrl ? 'reset_url' : 'retry',
    }
  }
  if (stableCode === 'server_forbidden' || status === 401 || status === 403) {
    return {
      code: 'server_forbidden',
      message: t('err.server.forbidden', { status: String(status) }),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'server_not_service' || status === 404) {
    return {
      code: 'server_not_service',
      message: t('err.server.notService'),
      detail: text,
      action: hasCustomUrl ? 'reset_url' : 'retry',
    }
  }
  if (stableCode === 'server_internal' || (status && status >= 500)) {
    return {
      code: 'server_internal',
      message: t('err.server.internal', { status: String(status) }),
      detail: text,
      action: 'retry',
    }
  }
  return {
    code: 'connect_failed',
    message: t('err.connectFailed'),
    detail: text,
    action: hasCustomUrl ? 'reset_url' : 'retry',
  }
}

export function describeProviderError(error: unknown): FriendlyError {
  const { code: stableCode, text } = decodeError(error)
  const status = extractHttpStatus(text)

  if (stableCode === 'provider_timeout' || isTimeout(text)) {
    return { code: 'provider_timeout', message: t('err.provider.timeout'), detail: text, action: 'retry' }
  }
  if (stableCode === 'provider_unreachable' || isNetworkFailure(text)) {
    return {
      code: 'provider_unreachable',
      message: t('err.provider.unreachable'),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'provider_bad_key' || status === 401 || /invalid.*(key|token)|unauthorized/i.test(text)) {
    return {
      code: 'provider_bad_key',
      message: t('err.provider.badKey'),
      detail: text,
      action: 'check_key',
    }
  }
  if (stableCode === 'provider_insufficient_balance'
    || status === 402
    || /payment required|insufficient balance|in balance|insufficient_quota/i.test(text)) {
    return {
      code: 'provider_insufficient_balance',
      message: t('err.provider.insufficientBalance'),
      detail: text,
      action: 'check_key',
    }
  }
  if (stableCode === 'provider_rate_limit' || status === 429 || /rate.?limit|quota/i.test(text)) {
    return {
      code: 'provider_rate_limit',
      message: t('err.provider.rateLimit'),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'provider_forbidden' || status === 403) {
    return {
      code: 'provider_forbidden',
      message: t('err.provider.forbidden'),
      detail: text,
      action: 'switch_source',
    }
  }
  if (stableCode === 'provider_no_model' || status === 404 || /model.*not.*(found|exist)/i.test(text)) {
    return {
      code: 'provider_no_model',
      message: t('err.provider.noModel'),
      detail: text,
      action: 'retry',
    }
  }
  return { code: 'connect_failed', message: t('err.connectFailed'), detail: text, action: 'retry' }
}

export function describeDownloadError(error: unknown): FriendlyError {
  const { code: stableCode, text } = decodeError(error)

  if (stableCode === 'download_busy') {
    return {
      code: 'download_busy',
      message: t('err.download.generic'),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'download_source_mismatch') {
    return {
      code: 'download_source_mismatch',
      message: t('err.download.checksum'),
      detail: text,
      action: 'switch_source',
    }
  }
  if (stableCode === 'download_network' || isTimeout(text) || isNetworkFailure(text)) {
    return {
      code: 'download_network',
      message: t('err.download.network'),
      detail: text,
      action: 'switch_source',
    }
  }
  if (stableCode === 'download_no_space' || /no space|disk full|not enough space/i.test(text)) {
    return {
      code: 'download_no_space',
      message: t('err.download.noSpace'),
      detail: text,
      action: 'none',
    }
  }
  if (stableCode === 'download_permission' || /permission|denied|access is denied/i.test(text)) {
    return {
      code: 'download_permission',
      message: t('err.download.permission'),
      detail: text,
      action: 'none',
    }
  }
  if (stableCode === 'download_checksum' || /checksum|sha256/i.test(text)) {
    return {
      code: 'download_checksum',
      message: t('err.download.checksum'),
      detail: text,
      action: 'switch_source',
    }
  }
  return {
    code: 'download_failed',
    message: t('err.download.generic'),
    detail: text,
    action: 'switch_source',
  }
}
