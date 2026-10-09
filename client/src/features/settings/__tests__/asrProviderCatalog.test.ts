import { describe, expect, it } from 'vitest'
import {
  ASR_PLATFORMS, ASR_PROVIDERS, ASR_COMPAT_PROTOCOLS,
  asrCardIdOfLegacyProvider, asrCardTitle,
  asrEndpointHost, asrEndpointUrl, asrModelsOf,
  describeAsrMissing, effectiveAsrCredentials,
  emptyAsrProfile, findAsrProvider, gradeAsrLatency,
  groupAsrModelsByVendor, parseAsrAudioEncoding,
  parseAsrCompatProtocol, parseAsrProfiles, parseAsrProfilesDetailed,
  providersOfPlatform, resolveActiveAsrProfile,
  resolveAsrApiModel, resolveAsrModel,
  resolveAsrModelOption, resolveAsrRuntimeProvider,
  type AsrModelOption, type AsrProfile,
} from '../asrProviderCatalog'

function profile(over: Partial<AsrProfile> = {}): AsrProfile {
  return {...emptyAsrProfile(),...over}
}

describe('compatible HTTP ASR catalog', () => {
  it('exposes one configurable HTTP provider', () => {
    expect(ASR_PROVIDERS.map(p=>p.id)).toEqual(['openai_compat'])
    expect(Object.keys(ASR_PLATFORMS)).toEqual(['openai_compat'])
    expect(providersOfPlatform('openai_compat')).toEqual(ASR_PROVIDERS)
  })
  it('keeps arbitrary model IDs and endpoint URLs', () => {
    const custom=profile({model:'gateway-model',apiUrl:'https://relay.example/v1'})
    expect(resolveAsrModel(custom)).toBe('gateway-model')
    expect(resolveAsrApiModel(custom)).toBe('gateway-model')
    expect(resolveAsrRuntimeProvider(custom)).toBe('openai_compat')
    expect(asrEndpointUrl(custom)).toBe('https://relay.example/v1')
  })
})

describe('OpenAI-compatible protocol, credentials and validation', () => {
  it('accepts supported protocol options, rejects invalid values', () => {
    expect(ASR_COMPAT_PROTOCOLS).toEqual(['auto','transcriptions','chat','chat_standard'])
    for(const p of ASR_COMPAT_PROTOCOLS) expect(parseAsrCompatProtocol(p)).toBe(p)
    for(const p of ['other','',null,undefined]) expect(parseAsrCompatProtocol(p)).toBe('auto')
  })
  it('defaults new profiles to MP3 while missing legacy settings remain WAV', () => {
    expect(emptyAsrProfile().audioEncoding).toBe('mp3')
    expect(parseAsrAudioEncoding('mp3')).toBe('mp3')
    for(const value of [undefined,null,'aac','']) expect(parseAsrAudioEncoding(value)).toBe('wav')
    for(const value of ['wav', undefined]) {
      expect(parseAsrProfiles([{id:'legacy',provider:'openai_compat',model:'custom',audioEncoding:value}])[0].audioEncoding).toBe('wav')
    }
  })
  it('requires a URL for a custom gateway, but not an API key for a self-hosted gateway', () => {
    const empty=profile({provider:'openai_compat',apiUrl:'',apiKey:''})
    expect(describeAsrMissing(empty)).not.toBe('')
    expect(describeAsrMissing({...empty,apiUrl:'http://127.0.0.1:8000/v1'})).toBe('')
    expect(effectiveAsrCredentials({...empty,apiKey:' sk-demo '}))
      .toEqual({apiKey:'sk-demo'})
  })

  it('shows configured domain and optional user-entered profile names without exposing keys', () => {
    const named=profile({provider:'openai_compat',name:'Private voice gateway',apiUrl:'https://my-gateway.example/v1',apiKey:'supersecret'})
    expect(asrCardTitle(named,2)).toBe('Private voice gateway')
    expect(asrEndpointHost(named)).toBe('my-gateway.example')
    expect(asrCardTitle({...named,name:''},2)).toContain('my-gateway.example')
    expect(asrCardTitle(named,2)).not.toContain('supersecret')
  })
})

describe('safe parsing and migration from older releases', () => {
  it('does not parse unknown or removed vendor profiles, but retains every byte via orphans', () => {
    const retired={id:'legacy',provider:'retired-vendor',model:'old',apiKey:'SECRET',extraKey:'private'}
    const alien={id:'next',provider:'future',model:'new',apiKey:'FUTURE'}
    const active={id:'a',provider:'groq',model:'whisper-large-v3',apiKey:'key'}
    const result=parseAsrProfilesDetailed([retired,alien,active])
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]).toMatchObject({id:'a',provider:'openai_compat',apiKey:'key'})
    expect(result.orphans).toEqual([retired,alien])
  })
  it('migrates known legacy dispatch keys to current platform cards', () => {
    const parsed=parseAsrProfiles([{id:'o',provider:'openai_transcribe',model:'gpt-transcribe',apiKey:'x'}])
    expect(parsed[0]).toMatchObject({id:'o',provider:'openai_compat',model:'gpt-transcribe',apiKey:'x',apiUrl:'https://api.openai.com/v1',protocol:'transcriptions'})
    expect(asrCardIdOfLegacyProvider('groq_whisper')).toBe('openai_compat')
    expect(asrCardIdOfLegacyProvider('retired-vendor')).toBe('retired-vendor')
  })
  it('retains unsupported Gemini, OpenRouter and realtime profiles as raw records', () => {
    const retired = [
      {id:'g',provider:'google',model:'gemini-3.5-transcribe',apiKey:'test-g'},
      {id:'r',provider:'openrouter',model:'openai/whisper-1',apiKey:'test-r'},
      {id:'o',provider:'openai',model:'gpt-live-transcribe',apiKey:'test-o'},
    ]
    expect(parseAsrProfilesDetailed(retired)).toEqual({profiles:[],orphans:retired})
  })
  it('migrates Groq without losing a customized model, endpoint or key', () => {
    expect(parseAsrProfiles([{id:'g',provider:'groq',model:'custom-whisper',apiKey:'test',apiUrl:'https://relay.example/v1'}])[0])
      .toMatchObject({provider:'openai_compat',model:'custom-whisper',apiKey:'test',apiUrl:'https://relay.example/v1',protocol:'transcriptions'})
  })
  it('preserves protocol, user text prompt, system instruction, model and encoding on parse', () => {
    const original={id:'1',provider:'openai_compat',apiUrl:'https://gateway.invalid/v1',model:'my-gemini',
      apiKey:'secret',protocol:'chat_standard',audioEncoding:'mp3',
      systemInstruction:'Transcribe precisely',userPrompt:'Preserve C# API names'}
    expect(parseAsrProfiles([original])[0]).toMatchObject(original)
  })
  it('handles invalid arrays, duplicated IDs and unknown entries without silently dropping them', () => {
    expect(parseAsrProfiles(null)).toEqual([])
    const raw=[null,'junk',{id:'dup',provider:'groq',model:'whisper-large-v3'}, {id:'dup',provider:'groq',model:'whisper-large-v3'}]
    const parsed=parseAsrProfilesDetailed(raw)
    expect(parsed.profiles).toHaveLength(1)
    expect(parsed.orphans).toHaveLength(3)
  })
  it('normalizes active IDs when removing a previously selected provider', () => {
    const entries=[profile({id:'p1'}),profile({id:'p2'})]
    expect(resolveActiveAsrProfile(entries,'retired')?.id).toBe('p1')
    expect(resolveActiveAsrProfile(entries,'p2')?.id).toBe('p2')
    expect(resolveActiveAsrProfile([],'any')).toBeNull()
  })
})

describe('display and latency quality', () => {
  it('groups OpenRouter models under their vendor prefixes, preserving order', () => {
    const models:AsrModelOption[]=[
      {id:'openai/whisper-1',provider:'openrouter_transcribe'},
      {id:'x-ai/grok-stt',provider:'openrouter_transcribe'},
      {id:'openai/transcribe',provider:'openrouter_transcribe'},
    ]
    expect(groupAsrModelsByVendor(models)?.map(([key])=>key)).toEqual(['openai','x-ai'])
    expect(groupAsrModelsByVendor([{id:'whisper-1',provider:'groq_whisper'}])).toBeNull()
  })
  it('classifies speed by real-time factor, not absolute latency alone', () => {
    expect(gradeAsrLatency(300,10).tier).toBe('instant')
    expect(gradeAsrLatency(3000,10).tier).toBe('normal')
    expect(gradeAsrLatency(3000,2).tier).toBe('tooSlow')
    expect(gradeAsrLatency(600,0).tier).toBe('normal')
  })
})
