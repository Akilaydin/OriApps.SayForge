import { describe, expect, it } from 'vitest'
import {
  describeDownloadError,
  describeProviderError,
  describeServerError,
} from '../errorMessages'

describe('describeServerError', () => {
  it('offers actionable fetch error recovery', () => {
    const result = describeServerError(new TypeError('Failed to fetch'), true)
    expect(result.message).not.toContain('Failed to fetch')
    expect(result.message).toContain('reach that address')
    expect(result.detail).toBe('Failed to fetch')
    expect(result.action).toBe('reset_url')
    expect(result.code).toBe('server_unreachable')
  })

  it('does not restore an already default endpoint', () => {
    expect(describeServerError(new TypeError('Failed to fetch'), false).action).toBe('retry')
  })

  it('classifies 401/403 as authorization failures', () => {
    const result = describeServerError(new Error('HTTP 403'), true)
    expect(result.message).toContain('refused')
    expect(result.message).toContain('403')
  })

  it('404 suggests verifying the endpoint URL', () => {
    expect(describeServerError(new Error('HTTP 404'), true).message).toContain('endpoint URL')
  })

  it('attributes 5xx failures to the provider', () => {
    expect(describeServerError(new Error('HTTP 502'), true).message).toContain('server')
  })

  it('classifies timeout separately', () => {
    expect(describeServerError(new Error('timeout'), true).message).toContain('too long')
  })

  it('does not display unknown raw errors as the main message', () => {
    const result = describeServerError(new Error('weird internal thing'), false)
    expect(result.message).toBe('Connection failed.')
    expect(result.detail).toBe('weird internal thing')
  })
})

describe('describeProviderError', () => {
  it('prefers stable native codes and strips the envelope prefix', () => {
    const result = describeProviderError('sayforge_error:provider_bad_key:HTTP 418 translated detail')
    expect(result.code).toBe('provider_bad_key')
    expect(result.action).toBe('check_key')
    expect(result.detail).toBe('HTTP 418 translated detail')
  })

  it('directs invalid-key failures to credentials', () => {
    const result = describeProviderError('Invalid API key')
    expect(result.message).toContain('key was rejected')
    expect(result.action).toBe('check_key')
    expect(result.code).toBe('provider_bad_key')
  })

  it('distinguishes rate limit and balance from invalid keys', () => {
    expect(describeProviderError(new Error('HTTP 429 rate limit')).message).toContain('rate-limit')
  })

  it('classifies 402 as insufficient balance', () => {
    const raw = describeProviderError(new Error(
      'OpenRouter transcription error 402 Payment Required [http=402] gen=-: '
      + '{"error":{"message":"This request requires at least $0.50 in balance for audio","code":402}}',
    ))
    expect(raw.code).toBe('provider_insufficient_balance')
    expect(raw.message).toContain('balance is too low')
    expect(raw.message).not.toContain('rate-limit')
    expect(raw.action).toBe('check_key')
    expect(raw.detail).toContain('$0.50')

    const tagged = describeProviderError('sayforge_error:provider_insufficient_balance:HTTP 402')
    expect(tagged.code).toBe('provider_insufficient_balance')
  })

  it('does not confuse 402, 429 and invalid keys', () => {
    expect(describeProviderError(new Error('HTTP 402 Payment Required')).code)
      .toBe('provider_insufficient_balance')
    expect(describeProviderError(new Error('HTTP 429 Too Many Requests: rate limit exceeded')).code)
      .toBe('provider_rate_limit')
  })

  it('403 suggests region or permission restrictions', () => {
    const tagged = describeProviderError('sayforge_error:provider_forbidden:API error 403 Forbidden [http=403]')
    expect(tagged.code).toBe('provider_forbidden')
    expect(tagged.message).not.toContain('key was rejected')
    expect(tagged.action).toBe('switch_source')

    const raw = describeProviderError(new Error('API error 403 Forbidden [http=403]: {"error":{"message":"Forbidden"}}'))
    expect(raw.code).toBe('provider_forbidden')
  })

  it('explicit invalid-key detail overrides generic 403', () => {
    expect(describeProviderError(new Error('HTTP 403: Invalid API key')).code).toBe('provider_bad_key')
  })

  it('suggests another provider for an unavailable model', () => {
    expect(describeProviderError(new Error('model not found')).message).toContain('model')
  })
})

describe('describeDownloadError', () => {
  it('stable error codes are independent of detail language', () => {
    const result = describeDownloadError('sayforge_error:download_no_space:write failed')
    expect(result.code).toBe('download_no_space')
    expect(result.action).toBe('none')
    expect(result.detail).toBe('write failed')
  })

  it('network interruption suggests another download source', () => {
    const result = describeDownloadError('error sending request for url (https://hf-mirror.com/...)')
    expect(result.message).toContain('another download source')
    expect(result.action).toBe('switch_source')
    expect(result.code).toBe('download_network')
    expect(result.detail).toContain('hf-mirror.com')
  })

  it('disk-full recovery does not suggest another source', () => {
    const result = describeDownloadError('No space left on device')
    expect(result.message).toContain('disk space')
    expect(result.action).toBe('none')
  })

  it('checksum failure suggests a new download', () => {
    expect(describeDownloadError('sha256 mismatch').action).toBe('switch_source')
  })

  it('duplicate downloads suggest retrying later', () => {
    const result = describeDownloadError('sayforge_error:download_busy:already downloading')
    expect(result.code).toBe('download_busy')
    expect(result.action).toBe('retry')
  })

  it('remote size mismatch suggests another source', () => {
    const result = describeDownloadError('sayforge_error:download_source_mismatch:size changed')
    expect(result.code).toBe('download_source_mismatch')
    expect(result.action).toBe('switch_source')
  })
})
