import { beforeEach, describe, expect, it, vi } from 'vitest'
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('@/services/store', () => ({
  getSetting: (key: string, fallback: unknown) => Promise.resolve(store.has(key) ? store.get(key) : fallback),
  setSetting: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
}))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))

import { ASR_ACTIVE_PROFILE_KEY, ASR_PROFILES_KEY, loadAsrProfiles, saveAsrProfiles, topUpProfiles } from '../asrProfileStore'
import { ASR_PROVIDERS, asrModelsOf, emptyAsrProfile, findAsrProvider, type AsrProfile } from '../asrProviderCatalog'

const creds = (apiKey: string) => ({apiKey, otherKey:'', appId:'', console:'new' as const, workspaceId:'', omniPrompt:''})
const profile = (provider: string, patch: Partial<AsrProfile> = {}): AsrProfile =>
  ({...emptyAsrProfile(provider), ...patch})

describe('international ASR profile auto-creation', () => {
  beforeEach(() => store.clear())

  it('creates exactly one named card for every supported platform with credentials', () => {
    const r = topUpProfiles([], {openai_compat:creds('test-key')})
    expect(r.profiles.map(p=>p.provider)).toEqual(ASR_PROVIDERS.map(p=>p.id))
    expect(r.profiles.every(p=>p.model.trim().length>0)).toBe(true)
  })
  it('ignores missing or blank API keys, and never creates a card for a removed provider', () => {
    expect(topUpProfiles([], {}).profiles).toEqual([])
    expect(topUpProfiles([], {openai_compat:creds('  ')}).profiles).toEqual([])
    expect(ASR_PROVIDERS.some(p=>['doubao','qwen','mimo'].includes(p.id))).toBe(false)
  })
  it('preserves an existing profile object and does not duplicate it', () => {
    const existing=[profile('openai_compat',{id:'a',apiKey:'my-key'})]
    const r=topUpProfiles(existing,{openai_compat:creds('another-key')})
    expect(r.profiles[0]).toBe(existing[0])
    expect(r.added).toEqual([])
    expect(topUpProfiles(r.profiles,{openai_compat:creds('another-key')}).added).toEqual([])
  })
  it('never recreates an intentionally deleted card recorded in auto-created history', () => {
    const r=topUpProfiles([],{openai_compat:creds('key')},['openai_compat'])
    expect(r.profiles).toEqual([])
  })
  it('sets the default model explicitly on each generated card', () => {
    const r=topUpProfiles([],{openai_compat:creds('key')})
    expect(r.profiles[0].model).toBe(asrModelsOf(findAsrProvider('openai_compat')!)[0].id)
  })
})

describe('ASR profile persistence and orphan protection', () => {
  beforeEach(() => store.clear())

  it('retains raw unsupported vendor profiles and their secrets on load and save', async () => {
    const retired={id:'old',provider:'qwen',model:'old-model',apiKey:'SECRET',otherKey:'SECONDARY'}
    const valid={id:'active',provider:'openai_compat',model:'gateway-asr',apiUrl:'https://private.example/v1',apiKey:'current'}
    const alien={id:'alien',provider:'future-provider',model:'next',apiKey:'FUTURE'}
    store.set(ASR_PROFILES_KEY,[retired,valid,alien])
    store.set(ASR_ACTIVE_PROFILE_KEY,'active')
    const loaded=await loadAsrProfiles()
    expect(loaded.profiles.map(p=>p.provider)).toEqual(['openai_compat'])
    await saveAsrProfiles(loaded)
    expect(store.get(ASR_PROFILES_KEY)).toContainEqual(retired)
    expect(store.get(ASR_PROFILES_KEY)).toContainEqual(alien)
    expect((store.get(ASR_PROFILES_KEY) as unknown[])).toHaveLength(3)
    expect(store.get(ASR_ACTIVE_PROFILE_KEY)).toBe('active')
  })
  it('persists migration and synchronizes runtime provider, URL and credentials', async () => {
    store.set(ASR_PROFILES_KEY,[{id:'old',provider:'groq',model:'custom',apiKey:'test'}])
    store.set(ASR_ACTIVE_PROFILE_KEY,'old')
    const loaded=await loadAsrProfiles()
    expect(loaded.profiles[0]).toMatchObject({id:'old',provider:'openai_compat',model:'custom'})
    expect(store.get('cloudAsr.provider')).toBe('openai_compat')
    expect(store.get('cloudAsr.baseUrl')).toBe('https://api.groq.com/openai/v1')
    expect(store.get('cloudAsr.apiKey')).toBe('test')
    expect(store.get('cloudAsr.protocol')).toBe('transcriptions')
  })
  it('migrates flat legacy settings before platform auto-creation', async () => {
    store.set('cloudAsr.provider','openai_transcribe')
    store.set('cloudAsr.model','custom')
    store.set('cloudAsr.apiKey','test-flat')
    store.set('cloudAsr.baseUrl','https://relay.example/v1')
    store.set('cloudAsr.openai_compat.apiKey','test-other')
    const loaded=await loadAsrProfiles()
    expect(loaded.profiles).toHaveLength(1)
    expect(loaded.profiles[0]).toMatchObject({model:'custom',apiKey:'test-flat',apiUrl:'https://relay.example/v1'})
  })
  it('preserves OpenAI-compatible system instruction, user prompt, MP3 mode and model', async () => {
    const first=profile('openai_compat',{
      id:'custom',model:'gemini-example',apiKey:'test',apiUrl:'https://api.example/v1',
      protocol:'chat_standard',audioEncoding:'mp3',systemInstruction:'Transcribe Russian',
      userPrompt:'Keep RabbitMQ spelling',
    })
    const second=profile('openai_compat',{id:'groq',apiKey:'other',audioEncoding:'wav'})
    store.set(ASR_PROFILES_KEY,[first,second])
    store.set(ASR_ACTIVE_PROFILE_KEY,'custom')
    const loaded=await loadAsrProfiles()
    expect(loaded.profiles.find(p=>p.id==='custom')).toMatchObject(first)
    await saveAsrProfiles({profiles:loaded.profiles,activeId:'custom'})
    expect(store.get('cloudAsr.model')).toBe('gemini-example')
    expect(store.get('cloudAsr.systemInstruction')).toBe('Transcribe Russian')
    expect(store.get('cloudAsr.userPrompt')).toBe('Keep RabbitMQ spelling')
    expect(store.get('cloudAsr.audioEncoding')).toBe('mp3')
    await saveAsrProfiles({profiles:loaded.profiles,activeId:'groq'})
    expect(store.get('cloudAsr.provider')).toBe('openai_compat')
    expect(store.get('cloudAsr.systemInstruction')).toBe('')
    expect(store.get('cloudAsr.audioEncoding')).toBe('wav')
  })
  it('normalizes the active ID to the first supported profile if previous selection was removed', async () => {
    const active=profile('openai_compat',{id:'survivor',apiKey:'key'})
    store.set(ASR_PROFILES_KEY,[{id:'old',provider:'doubao_v2',model:'old',apiKey:'OLD-SECRET'},active])
    store.set(ASR_ACTIVE_PROFILE_KEY,'old')
    const loaded=await loadAsrProfiles()
    expect(loaded.activeId).toBe('survivor')
    expect(store.get(ASR_ACTIVE_PROFILE_KEY)).toBe('survivor')
    expect(store.get(ASR_PROFILES_KEY)).toContainEqual({id:'old',provider:'doubao_v2',model:'old',apiKey:'OLD-SECRET'})
  })
  it('never discards unknown records when all active profiles disappear', async () => {
    const alien={id:'unknown',provider:'future',apiKey:'SECRET'}
    store.set(ASR_PROFILES_KEY,[alien])
    store.set('cloudAsr.apiKey','legacy-test')
    store.set('cloudAsr.baseUrl','https://legacy.example/v1')
    const loaded=await loadAsrProfiles()
    await saveAsrProfiles(loaded)
    expect(store.get(ASR_PROFILES_KEY)).toEqual([alien])
    expect(store.get('cloudAsr.apiKey')).toBe('legacy-test')
    expect(store.get('cloudAsr.baseUrl')).toBe('https://legacy.example/v1')
  })
})
