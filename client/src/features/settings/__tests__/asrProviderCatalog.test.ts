import { describe, expect, it } from 'vitest'
import { isStreamingDisplayReady } from '@/lib/asrModels'
import {
  ASR_PLATFORMS, ASR_PROVIDERS, ASR_COMPAT_PROTOCOLS,
  asrAvailabilityLabel, asrCardIdOfLegacyProvider, asrCardTitle,
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

describe('international ASR catalog and provider routing', () => {
  it('exposes exactly supported providers with unique IDs', () => {
    expect(ASR_PROVIDERS.map(p=>p.id)).toEqual(['groq','openai','google','openrouter','openai_compat'])
    expect(Object.keys(ASR_PLATFORMS)).toEqual(['groq','openai','google','openrouter','openai_compat'])
    expect(new Set(ASR_PROVIDERS.map(p=>p.id)).size).toBe(ASR_PROVIDERS.length)
    for(const entry of ASR_PROVIDERS) {
      expect(entry.id).toBe(entry.platform)
      expect(entry.label.trim().length).toBeGreaterThan(0)
      expect(entry.blurb.trim().length).toBeGreaterThan(0)
      expect(asrModelsOf(entry).length).toBeGreaterThan(0)
      expect(entry.availability).toBe('global')
      expect(providersOfPlatform(entry.platform)).toEqual([entry])
    }
    for(const unsupported of ['doubao','mimo','qwen']) expect(findAsrProvider(unsupported)).toBeUndefined()
  })
  it('maps OpenAI and Gemini file vs live variants to different dispatch keys', () => {
    const openai=asrModelsOf(findAsrProvider('openai')!)
    expect(openai.find(m=>m.id==='gpt-transcribe')?.provider).toBe('openai_transcribe')
    expect(openai.find(m=>m.id==='gpt-live-transcribe')?.provider).toBe('openai_live_transcribe')
    const google=asrModelsOf(findAsrProvider('google')!)
    expect(new Set(google.map(m=>m.provider))).toEqual(new Set(['gemini_transcribe','gemini_live_transcribe']))
    expect(isStreamingDisplayReady('openai_live_transcribe')).toBe(true)
    expect(isStreamingDisplayReady('gemini_live_transcribe')).toBe(true)
    expect(isStreamingDisplayReady('qwen_realtime')).toBe(false)
  })
  it('uses selected model dispatch instead of card/platform ID', () => {
    expect(resolveAsrRuntimeProvider(profile({provider:'google',model:'gemini-3.5-transcribe-live'})))
      .toBe('gemini_live_transcribe')
    expect(resolveAsrRuntimeProvider(profile({provider:'openai',model:'gpt-4o-mini-transcribe'})))
      .toBe('openai_transcribe')
    expect(resolveAsrModel(profile({provider:'groq',model:'whisper-large-v3'}))).toBe('whisper-large-v3')
  })
  it('keeps arbitrary model IDs for a user-provided compatible endpoint', () => {
    const custom=profile({provider:'openai_compat',model:'gemini-3.8-flash-high'})
    expect(resolveAsrModel(custom)).toBe('gemini-3.8-flash-high')
    expect(resolveAsrApiModel(custom)).toBe('gemini-3.8-flash-high')
    expect(resolveAsrRuntimeProvider(custom)).toBe('openai_compat')
    expect(resolveAsrModelOption(custom)?.id).toBe('gemini-3.8-flash-high')
  })
  it('uses the catalog default for obsolete built-in model names', () => {
    const bad=profile({provider:'groq',model:'retired-whisper'})
    expect(resolveAsrModel(bad)).toBe(asrModelsOf(findAsrProvider('groq')!)[0].id)
  })
  it('never forwards a leftover URL into a realtime provider', () => {
    expect(asrEndpointUrl(profile({provider:'openai',model:'gpt-live-transcribe',apiUrl:'https://old.invalid/v1'})))
      .toBe('')
    expect(asrEndpointUrl(profile({provider:'openai',model:'gpt-transcribe',apiUrl:'https://relay.example/v1'})))
      .toBe('https://relay.example/v1')
  })
})

describe('OpenAI-compatible protocol, credentials and validation', () => {
  it('accepts supported protocol options, rejects invalid values', () => {
    expect(ASR_COMPAT_PROTOCOLS).toEqual(['auto','transcriptions','chat','chat_standard'])
    for(const p of ASR_COMPAT_PROTOCOLS) expect(parseAsrCompatProtocol(p)).toBe(p)
    for(const p of ['other','',null,undefined]) expect(parseAsrCompatProtocol(p)).toBe('auto')
  })
  it('allows optional MP3 explicitly but defaults to WAV', () => {
    expect(parseAsrAudioEncoding('mp3')).toBe('mp3')
    for(const value of [undefined,null,'aac','']) expect(parseAsrAudioEncoding(value)).toBe('wav')
  })
  it('requires a URL for a custom gateway, but not an API key for a self-hosted gateway', () => {
    const empty=profile({provider:'openai_compat',apiUrl:'',apiKey:''})
    expect(describeAsrMissing(empty)).not.toBe('')
    expect(describeAsrMissing({...empty,apiUrl:'http://127.0.0.1:8000/v1'})).toBe('')
    expect(effectiveAsrCredentials({...empty,apiKey:' sk-demo '}))
      .toEqual({apiKey:'sk-demo',appId:''})
  })
  it('requires a key for built-in cloud providers', () => {
    const groq=profile({provider:'groq',apiKey:''})
    expect(describeAsrMissing(groq)).not.toBe('')
    expect(describeAsrMissing({...groq,apiKey:'key'})).toBe('')
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
    const retired={id:'legacy',provider:'qwen',model:'old',apiKey:'SECRET',workspaceId:'private'}
    const alien={id:'next',provider:'future',model:'new',apiKey:'FUTURE'}
    const active={id:'a',provider:'groq',model:'whisper-large-v3',apiKey:'key'}
    const result=parseAsrProfilesDetailed([retired,alien,active])
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]).toMatchObject({id:'a',provider:'groq',apiKey:'key'})
    expect(result.orphans).toEqual([retired,alien])
  })
  it('migrates known legacy dispatch keys to current platform cards', () => {
    const parsed=parseAsrProfiles([{id:'o',provider:'openai_transcribe',model:'gpt-transcribe',apiKey:'x'}])
    expect(parsed[0]).toMatchObject({id:'o',provider:'openai',model:'gpt-transcribe',apiKey:'x'})
    expect(asrCardIdOfLegacyProvider('gemini_live_transcribe')).toBe('google')
    expect(asrCardIdOfLegacyProvider('qwen')).toBe('qwen')
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
  it('avoids unsupported geographic claims about an arbitrary endpoint', () => {
    expect(asrAvailabilityLabel(findAsrProvider('openai_compat')!)).toBe('')
    expect(asrAvailabilityLabel(findAsrProvider('groq')!)).not.toBe('')
  })
  it('classifies speed by real-time factor, not absolute latency alone', () => {
    expect(gradeAsrLatency(300,10).tier).toBe('instant')
    expect(gradeAsrLatency(3000,10).tier).toBe('normal')
    expect(gradeAsrLatency(3000,2).tier).toBe('tooSlow')
    expect(gradeAsrLatency(600,0).tier).toBe('normal')
  })
})
