import { describe, it, expect } from 'vitest'
import { isSensitiveKey, maskValue, sanitizeObject } from '../sanitize'

describe('isSensitiveKey', () => {
  it('recognizes sensitive keys', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('api_key')).toBe(true)
    expect(isSensitiveKey('cloudAsr.apiKey')).toBe(true)
    expect(isSensitiveKey('access_token')).toBe(true)
    expect(isSensitiveKey('accessToken')).toBe(true)
    expect(isSensitiveKey('password')).toBe(true)
    expect(isSensitiveKey('secret')).toBe(true)
    expect(isSensitiveKey('app_id')).toBe(true)
    expect(isSensitiveKey('appId')).toBe(true)
  })

  it('does not redact ordinary keys', () => {
    expect(isSensitiveKey('theme')).toBe(false)
    expect(isSensitiveKey('language')).toBe(false)
    expect(isSensitiveKey('selectedMic')).toBe(false)
    expect(isSensitiveKey('activePresetId')).toBe(false)
    expect(isSensitiveKey('workMode')).toBe(false)
  })
})

describe('maskValue', () => {
  it('retains ends of long secrets', () => {
    expect(maskValue('sk-1234567890abcdef')).toBe('sk-***ef')
  })

  it('fully masks short secrets', () => {
    expect(maskValue('abc')).toBe('***')
    expect(maskValue('12345678')).toBe('***')
  })

  it('masks empty values', () => {
    expect(maskValue('')).toBe('***')
    expect(maskValue(null)).toBe('***')
    expect(maskValue(undefined)).toBe('***')
  })
})

describe('sanitizeObject', () => {
  it('redacts nested sensitive fields', () => {
    const input = {
      theme: 'dark',
      cloudAsr: {
        provider: 'doubao',
        apiKey: 'sk-1234567890abcdef',
        appId: 'app-9876543210',
      },
      cloudAi: {
        apiKey: 'key-abcdefghijklmn',
        model: 'deepseek-chat',
      },
    }
    const result = sanitizeObject(input)

    expect(result.theme).toBe('dark')
    expect(result.cloudAsr.provider).toBe('doubao')
    expect(result.cloudAi.model).toBe('deepseek-chat')

    expect(result.cloudAsr.apiKey).toBe('sk-***ef')
    expect(result.cloudAsr.appId).toBe('app***10')
    expect(result.cloudAi.apiKey).toBe('key***mn')
  })

  it('preserves the original object', () => {
    const input = { apiKey: 'sk-1234567890' }
    const result = sanitizeObject(input)
    expect(input.apiKey).toBe('sk-1234567890')
    expect(result.apiKey).toBe('sk-***90')
  })

  it('handles arrays', () => {
    const input = [{ apiKey: 'sk-1234567890' }, { name: 'test' }]
    const result = sanitizeObject(input)
    expect(result[0].apiKey).toBe('sk-***90')
    expect(result[1].name).toBe('test')
  })

  it('handles null and undefined', () => {
    expect(sanitizeObject(null)).toBeNull()
    expect(sanitizeObject(undefined)).toBeUndefined()
  })

  it('preserves empty sensitive string fields', () => {
    const input = { apiKey: '' }
    const result = sanitizeObject(input)
    expect(result.apiKey).toBe('')
  })
})
