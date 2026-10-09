import { describe, expect, it } from 'vitest'
import {
  buildAsrExtra,
  resolveAsrDisplayModel,
} from '../asrModels'

describe('supported international ASR providers', () => {
  it('has human-readable default model names for major providers', () => {
    expect(resolveAsrDisplayModel('groq_whisper')).toBe('groq_whisper')
    expect(resolveAsrDisplayModel('openai_transcribe')).toBe('openai_transcribe')
    expect(resolveAsrDisplayModel('custom_provider')).toBe('custom_provider')
    expect(resolveAsrDisplayModel('')).toBe('unknown')
  })
  it('preserves selected model instead of reverting to provider default', () => {
    expect(resolveAsrDisplayModel('groq_whisper', 'whisper-large-v3')).toBe('whisper-large-v3')
    expect(resolveAsrDisplayModel('openai_transcribe', 'gpt-4o-mini-transcribe'))
      .toBe('gpt-4o-mini-transcribe')
    expect(resolveAsrDisplayModel('groq_whisper', '')).toBe('groq_whisper')
    expect(resolveAsrDisplayModel('groq_whisper', '  ')).toBe('groq_whisper')
  })
})

describe('OpenAI-compatible audio request construction', () => {
  it('preserves MP3 option, custom system/user prompts and the exact model name', () => {
    expect(buildAsrExtra('openai_compat', {
      model: 'gemini-example', protocol: 'chat_standard',
      instructions: 'Transcribe Russian speech.',
      userPrompt: 'Keep C# and RabbitMQ spelling.',
      audioEncoding: 'mp3',
    })).toEqual({
      model: 'gemini-example', protocol: 'chat_standard',
      instructions: 'Transcribe Russian speech.',
      userPrompt: 'Keep C# and RabbitMQ spelling.',
      audioEncoding: 'mp3',
    })
  })
  it('omits default options and empty strings', () => {
    expect(buildAsrExtra('openai_compat', {audioEncoding: 'wav'})).toBeUndefined()
    expect(buildAsrExtra('groq_whisper')).toBeUndefined()
    expect(buildAsrExtra('groq_whisper', {model: '  '})).toBeUndefined()
  })
  it('preserves a user-provided model and endpoint even when not in a built-in catalog', () => {
    expect(buildAsrExtra('openai_compat', {
      model:'custom-asr-model',baseUrl:'http://127.0.0.1:8000/v1',
    })).toEqual({model:'custom-asr-model',baseUrl:'http://127.0.0.1:8000/v1'})
    expect(buildAsrExtra('groq_whisper', {model:'whisper-large-v3',baseUrl:' '}))
      .toEqual({model:'whisper-large-v3'})
  })
  it('does not silently infer models from removed vendor-specific provider IDs', () => {
    expect(buildAsrExtra('qwen_omni_35_plus')).toBeUndefined()
    expect(buildAsrExtra('doubao_v2')).toBeUndefined()
  })
})
