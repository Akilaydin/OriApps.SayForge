import { t } from '@/i18n'
import * as bridge from '@/services/bridge'
import { getBackendBaseUrl } from '@/services/runtimeConfig'
import { getSetting, setSetting, type HistoryRecord } from '@/services/store'
import { normalizeForDiff } from '@/lib/asrDiff'


export const ASR_CORRECTION_CONSENT_VERSION = '1'
const CONSENT_SETTING_KEY = 'asrCorrectionConsentVersion'

export const ASR_CORRECTION_WITHDRAW_DAYS = 30

export const MAX_CORRECTION_AUDIO_BYTES = 10 * 1024 * 1024

export type AsrCorrectionErrorCode =
  | 'audio_missing'
  | 'audio_too_large'
  | 'no_change'
  | 'rate_limited'
  | 'already_submitted'
  | 'storage_full'
  | 'network'
  | 'not_supported'
  | 'server'

export interface AsrCorrectionResult {
  ok: boolean
  correctionId?: string
  code?: AsrCorrectionErrorCode
  message: string
}

export async function hasAsrCorrectionConsent(): Promise<boolean> {
  const stored = await getSetting<string>(CONSENT_SETTING_KEY, '')
  return stored === ASR_CORRECTION_CONSENT_VERSION
}

export async function grantAsrCorrectionConsent(): Promise<void> {
  await setSetting(CONSENT_SETTING_KEY, ASR_CORRECTION_CONSENT_VERSION)
}

export function buildCorrectionId(recordId: string): string {
  const safe = (recordId || '').replace(/[^A-Za-z0-9_-]/g, '')
  return `c-${safe}`.padEnd(8, '0').slice(0, 64)
}

function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function messageForCode(code: AsrCorrectionErrorCode, status?: number): string {
  switch (code) {
    case 'audio_missing':
      return t('asrCorrection.errorAudioMissing')
    case 'audio_too_large':
      return t('asrCorrection.errorAudioTooLarge')
    case 'no_change':
      return t('asrCorrection.errorNoChange')
    case 'rate_limited':
      return t('asrCorrection.errorRateLimited')
    case 'already_submitted':
      return t('asrCorrection.errorAlreadySubmitted')
    case 'storage_full':
      return t('asrCorrection.errorStorageFull')
    case 'network':
      return t('asrCorrection.errorNetwork')
    case 'not_supported':
      return t('asrCorrection.errorNotSupported')
    default:
      return t('asrCorrection.errorServer', { status: status ?? 0 })
  }
}

function classifyServerError(error: string): AsrCorrectionErrorCode {
  if (error === 'rate_limited') return 'rate_limited'
  if (error === 'already_submitted') return 'already_submitted'
  if (error === 'storage_full') return 'storage_full'
  if (error === 'audio_too_large') return 'audio_too_large'
  if (error === 'no_change') return 'no_change'
  return 'server'
}

export async function submitAsrCorrection(
  record: HistoryRecord,
  correctedText: string,
): Promise<AsrCorrectionResult> {
  const original = normalizeForDiff(record.asrText || '')
  const corrected = normalizeForDiff(correctedText)
  if (!original || !corrected) {
    return { ok: false, code: 'no_change', message: messageForCode('no_change') }
  }
  if (original === corrected) {
    return { ok: false, code: 'no_change', message: messageForCode('no_change') }
  }

  if (!record.audioFilePath) {
    return { ok: false, code: 'audio_missing', message: messageForCode('audio_missing') }
  }
  const base64 = await bridge.readAudioFile(record.audioFilePath).catch(() => null)
  if (!base64) {
    return { ok: false, code: 'audio_missing', message: messageForCode('audio_missing') }
  }

  const bytes = base64ToBytes(base64)
  if (bytes.byteLength > MAX_CORRECTION_AUDIO_BYTES) {
    return { ok: false, code: 'audio_too_large', message: messageForCode('audio_too_large') }
  }

  const clientInfo = await bridge.getClientRuntimeInfo().catch(() => null)
  const correctionId = buildCorrectionId(record.id)

  const form = new FormData()
  form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'recording.wav')
  form.append('correction_id', correctionId)
  form.append('machine_id', clientInfo?.deviceId || 'unknown')
  form.append('original_asr_text', original)
  form.append('corrected_text', corrected)
  form.append('work_mode', record.workMode || 'server')
  form.append('app_version', clientInfo?.clientVersion || '')
  form.append('client_record_id', record.id)
  form.append('asr_provider', record.asrProvider || '')
  form.append('hotwords', JSON.stringify(record.autoAppliedHotwords || []))
  form.append('consent_version', ASR_CORRECTION_CONSENT_VERSION)

  let response: Response
  try {
    response = await fetch(`${getBackendBaseUrl()}/api/asr-corrections`, { method: 'POST', body: form })
  } catch {
    return { ok: false, code: 'network', message: messageForCode('network') }
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  if (response.ok) {
    return {
      ok: true,
      correctionId: String(body.correction_id || correctionId),
      message: t('asrCorrection.submitted'),
    }
  }

  const errorCode = String(body.error || '')
  if (response.status === 409 && errorCode === 'already_submitted') {
    return {
      ok: true,
      correctionId: String(body.correction_id || correctionId),
      message: t('asrCorrection.alreadySubmitted'),
    }
  }

  if (response.status === 404 || response.status === 405) {
    return { ok: false, code: 'not_supported', message: messageForCode('not_supported') }
  }

  const code = classifyServerError(errorCode)
  return { ok: false, code, message: messageForCode(code, response.status) }
}

export async function withdrawAsrCorrection(correctionId: string): Promise<boolean> {
  const clientInfo = await bridge.getClientRuntimeInfo().catch(() => null)
  try {
    const response = await fetch(
      `${getBackendBaseUrl()}/api/asr-corrections/${encodeURIComponent(correctionId)}/withdraw`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine_id: clientInfo?.deviceId || 'unknown' }),
      },
    )
    return response.ok || response.status === 404
  } catch {
    return false
  }
}
