
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
  | 'clipboard_unsupported_format'
  | 'clipboard_unavailable'
  | 'clipboard_write_failed'
  | 'storage_failed'
  | 'storage_locked'
  | 'storage_readonly'
  | 'storage_invalid_data'
  | 'storage_no_space'

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
  'clipboard_unsupported_format',
  'clipboard_unavailable',
  'clipboard_write_failed',
  'storage_failed',
  'storage_locked',
  'storage_readonly',
  'storage_invalid_data',
  'storage_no_space',
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
  return /timeout|timed out|deadline (?:elapsed|exceeded)|etimedout/i.test(text)
}

export interface FailureDiagnostic {
  kind: 'timeout' | 'http' | 'network' | 'local'
  name: string
  code?: FriendlyErrorCode
  httpStatus?: number
  reason?: 'dns' | 'tls' | 'connection' | 'permission' | 'disk_full' | 'busy' | 'unsupported_format' | 'invalid_data' | 'not_found'
  nativeCode?: string
  cause?: FailureDiagnostic
}

const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'DOMException',
  'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError',
  'NetworkError', 'SecurityError', 'TimeoutError'])

/** Only categorical causes/codes are retained: exception bodies can contain speech or credentials. */
export function diagnoseFailure(error: unknown, depth = 0): FailureDiagnostic {
  try {
    const { code, text } = decodeError(error)
    const rawName = error instanceof Error ? error.name : text.match(/^([A-Za-z]+Error):/)?.[1]
    const name = rawName && ERROR_NAMES.has(rawName) ? rawName : 'Error'
    const httpStatus = extractHttpStatus(text) ?? undefined
    let reason: FailureDiagnostic['reason']
    if (/dns|enotfound|name (?:or service|resolution)|failed to resolve|lookup address/i.test(text)) reason = 'dns'
    else if (/tls|ssl|certificate/i.test(text)) reason = 'tls'
    else if (code === 'clipboard_unsupported_format' || /unsupported clipboard format|not a bounded HGLOBAL/i.test(text)) reason = 'unsupported_format'
    else if (code === 'storage_locked' || /database is (?:locked|busy)|sqlite_(?:busy|locked)/i.test(text)) reason = 'busy'
    else if (code === 'storage_readonly' || name === 'NotAllowedError' || name === 'SecurityError' || /permission|access (?:is )?denied|read.?only/i.test(text)) reason = 'permission'
    else if (code === 'storage_no_space' || /disk full|no space|not enough space/i.test(text)) reason = 'disk_full'
    else if (code === 'storage_invalid_data') reason = 'invalid_data'
    else if (name === 'NotFoundError' || /not found|no such file/i.test(text)) reason = 'not_found'
    else if (isNetworkFailure(text) || name === 'NetworkError') reason = 'connection'
    const kind = isTimeout(text) || name === 'TimeoutError' ? 'timeout'
      : httpStatus ? 'http'
        : reason === 'dns' || reason === 'tls' || reason === 'connection' ? 'network' : 'local'
    const nativeCode = text.match(/\b(?:HRESULT\s*[:=]?\s*)?(0x[0-9a-f]{8})\b/i)?.[1]
    const diagnostic: FailureDiagnostic = { kind, name,
      ...(code ? { code } : {}), ...(httpStatus ? { httpStatus } : {}),
      ...(reason ? { reason } : {}), ...(nativeCode ? { nativeCode } : {}) }
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined
    if (depth < 2 && cause && cause !== error) {
      diagnostic.cause = diagnoseFailure(cause, depth + 1)
    }
    return diagnostic
  } catch {
    return { kind: 'local', name: 'Error' }
  }
}

/** Append a known cause/action to a caller's user-facing description; never show raw diagnostics. */
export function failureMessage(error: unknown, fallback: string): string {
  const diagnostic = diagnoseFailure(error)
  let hint: string | undefined
  if (diagnostic.code === 'clipboard_unavailable') hint = t('err.operation.clipboardUnavailable')
  else if (diagnostic.kind === 'timeout') hint = t('err.operation.timeout')
  else if (diagnostic.kind === 'http') hint = t('err.operation.http', { status: String(diagnostic.httpStatus) })
  else if (diagnostic.reason === 'dns') hint = t('err.operation.dns')
  else if (diagnostic.reason === 'tls') hint = t('err.operation.tls')
  else if (diagnostic.kind === 'network') hint = t('err.operation.network')
  else if (diagnostic.reason === 'permission') hint = t('err.operation.permission')
  else if (diagnostic.reason === 'disk_full') hint = t('err.operation.diskFull')
  else if (diagnostic.reason === 'busy') hint = t('err.operation.busy')
  else if (diagnostic.reason === 'unsupported_format') hint = t('err.operation.clipboardFormat')
  else if (diagnostic.reason === 'invalid_data') hint = t('err.operation.invalidData')
  else if (diagnostic.reason === 'not_found') hint = t('err.operation.notFound')
  return hint ? `${fallback} ${hint}` : fallback
}

export function insertionFailureMessage(reason: string): string {
  if (reason === 'insertion_timeout') return t('overlay.insertionTimeoutHint')
  if (reason === 'paste_unconfirmed') return t('overlay.unconfirmedHint')
  if (reason === 'clipboard_changed') return t('overlay.clipboardChangedHint')
  if (reason.startsWith('clipboard_')) {
    return failureMessage(`${ERROR_PROTOCOL_PREFIX}${reason}:`, t('overlay.clipboardFailedHint'))
  }
  if (['invalid_target', 'target_not_foreground', 'focus_not_confirmed'].includes(reason)) return t('overlay.focusLostHint')
  if (reason === 'input_blocked_access_denied' || reason === 'send_input_short_write') return t('overlay.inputBlockedHint')
  return reason === 'not_editable' ? t('overlay.fallbackHint') : t('overlay.insertionFailedHint')
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
