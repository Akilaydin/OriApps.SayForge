import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), settings: new Map<string, unknown>() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/store', () => ({ getSetting: (key: string, fallback: unknown) => Promise.resolve(mocks.settings.get(key) ?? fallback) }))
vi.mock('@/services/bridge', () => ({ notifyAsrCapabilityMaybeChanged: vi.fn(), storeGetSettings: mocks.read }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))
import { CloudAPIProvider } from '../CloudAPIProvider'
import type { StartOptions } from '../types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const result = (text: string) => ({ text, elapsed_ms: 20 })
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
function record(provider: CloudAPIProvider, runId: number, patch: Partial<StartOptions> = {}) {
  expect(provider.start({ runId, ...patch })).toBe(true)
  provider.sendAudio(new ArrayBuffer(16000))
  expect(provider.stop()).toBe(true)
}

beforeEach(() => {
  mocks.invoke.mockReset(); mocks.settings.clear()
  mocks.read.mockReset().mockImplementation(() => Promise.resolve(Object.fromEntries(mocks.settings)))
})

describe.each(['transcriptions', 'chat_standard'])('long cloud request using %s', (protocol) => {
  afterEach(() => vi.useRealTimers())

  it.each(['mp3', 'wav'])('delivers a delayed five-minute %s recording without a second request', async (audioEncoding) => {
    vi.useFakeTimers()
    mocks.settings.set('cloudAsr.protocol', protocol)
    mocks.settings.set('cloudAsr.audioEncoding', audioEncoding)
    const pending = deferred<ReturnType<typeof result>>()
    mocks.invoke.mockReturnValue(pending.promise)
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onDone = vi.fn()
    await provider.connect({ onFinal, onDone })
    provider.start({ runId: 1 })
    provider.sendAudio(new ArrayBuffer(16000 * 2 * 300))
    provider.stop()
    await settle()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(onFinal).not.toHaveBeenCalled()
    pending.resolve(result('Delayed synthetic transcript'))
    await settle()
    expect(mocks.invoke).toHaveBeenCalledOnce()
    const extra = mocks.invoke.mock.calls[0][1].request.asr_config.extra
    expect(extra.protocol).toBe(protocol)
    expect(extra.audioEncoding ?? 'wav').toBe(audioEncoding)
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ durationSec: 300, asrText: 'Delayed synthetic transcript' }))
    expect(onDone).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('suppresses a late %s after user cancellation', async (completion) => {
    vi.useFakeTimers()
    mocks.settings.set('cloudAsr.protocol', protocol)
    const pending = deferred<ReturnType<typeof result>>()
    mocks.invoke.mockReturnValue(pending.promise)
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onDone = vi.fn(), onError = vi.fn()
    await provider.connect({ onFinal, onDone, onError })
    record(provider, 1)
    await settle()
    await vi.advanceTimersByTimeAsync(180_000)
    provider.cancel()
    if (completion === 'resolve') pending.resolve(result('Canceled synthetic transcript'))
    else pending.reject(new Error('Canceled synthetic failure'))
    await settle()
    expect(onFinal).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
describe('buffered cloud recording run isolation', () => {
  it('uploads configured endpoint, model, encoding and a snapshot of hotwords once after stop', async () => {
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onDone = vi.fn()
    await provider.connect({ onFinal, onDone })
    for (const [key, value] of Object.entries({ baseUrl:'https://relay.example/v1', model:'custom-model', protocol:'chat_standard', audioEncoding:'mp3', apiKey:'test' })) mocks.settings.set('cloudAsr.' + key,value)
    mocks.invoke.mockResolvedValue(result('Synthetic text'))
    const hotwords = ['RabbitMQ']
    record(provider, 1, { hotwords }); hotwords.push('Later')
    await settle()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_transcribe', { request: expect.objectContaining({
      hotwords:['RabbitMQ'], sample_rate:16000,
      asr_config:expect.objectContaining({provider:'openai_compat',api_key:'test',extra:expect.objectContaining({baseUrl:'https://relay.example/v1',model:'custom-model',audioEncoding:'mp3'})}),
    }) })
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ asrText:'Synthetic text' }))
    expect(onDone).toHaveBeenCalledOnce()
  })
  it('ignores retired cleanup settings and returns an empty ASR result without another call', async () => {
    mocks.settings.set('aiEnabled', true)
    mocks.settings.set('cloudAi.apiKey', 'synthetic-retired-key')
    mocks.invoke.mockResolvedValue(result(''))
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onDone = vi.fn()
    await provider.connect({ onFinal, onDone })
    record(provider, 1); await settle()
    expect(mocks.invoke).toHaveBeenCalledOnce()
    expect(mocks.invoke.mock.calls[0][0]).toBe('cloud_transcribe')
    expect(onFinal).toHaveBeenCalledWith({ asrText: '', asrMs: 20, durationSec: 0.5 })
    expect(onDone).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('ignores cancelled responses: %s', async (completion) => {
    const first = deferred<ReturnType<typeof result>>(), second = deferred<ReturnType<typeof result>>()
    mocks.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onError = vi.fn(), onDone = vi.fn()
    await provider.connect({ onFinal, onError, onDone })
    record(provider,1); await settle(); provider.cancel()
    record(provider,2); await settle()
    if (completion === 'resolve') first.resolve(result('Stale')); else first.reject(new Error('Stale failure'))
    await settle()
    expect(onFinal).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled()
    second.resolve(result('Current')); await settle()
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({asrText:'Current'}))
    expect(onDone).toHaveBeenCalledOnce()
  })
  it.each(['Network unavailable', 'Request timed out'])('reports %s without producing text', async (message) => {
    mocks.invoke.mockRejectedValue(new Error(message))
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onError = vi.fn(), onDone = vi.fn()
    await provider.connect({onFinal,onError,onDone}); record(provider,1); await settle()
    expect(onError).toHaveBeenCalledWith('Error: ' + message)
    expect(onDone).toHaveBeenCalledOnce(); expect(onFinal).not.toHaveBeenCalled()
  })
  it('honors synchronous cancellation from the ASR callback', async () => {
    mocks.invoke.mockResolvedValue(result('Synthetic'))
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onDone = vi.fn()
    await provider.connect({onASR:()=>provider.cancel(),onFinal,onDone}); record(provider,1); await settle()
    expect(onFinal).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled()
  })
  it('keeps a complete active profile snapshot despite changes during recording', async () => {
    const old = {id:'a',provider:'openai_compat',model:'old',apiUrl:'https://old.invalid/v1',apiKey:'old-key',protocol:'chat_standard',audioEncoding:'mp3',systemInstruction:'Old instruction',reasoningEffort:'low'}
    mocks.settings.set('cloudAsr.profiles',[old])
    mocks.settings.set('cloudAsr.activeProfileId','a')
    mocks.settings.set('cloudAsr.apiKey','mixed-flat-key')
    mocks.invoke.mockResolvedValue(result('Synthetic'))
    const provider = new CloudAPIProvider()
    await provider.connect({})
    provider.start({runId:1}); await settle()
    mocks.settings.set('cloudAsr.profiles',[{...old,apiKey:'new-key',model:'new',reasoningEffort:'high'}])
    provider.sendAudio(new ArrayBuffer(16000)); provider.stop(); await settle()
    expect(mocks.invoke.mock.calls[0][1].request.asr_config).toMatchObject({api_key:'old-key',extra:{model:'old',instructions:'Old instruction',reasoningEffort:'low'}})
    expect(mocks.invoke.mock.calls[0][1].request.asr_config.extra).not.toHaveProperty('userPrompt')
    record(provider,2); await settle()
    expect(mocks.invoke.mock.calls[1][1].request.asr_config).toMatchObject({api_key:'new-key',extra:{model:'new',reasoningEffort:'high'}})
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })
  it.each(['resolve','reject'] as const)('isolates late settings completion: %s', async completion => {
    const pending = deferred<Record<string,unknown>>()
    mocks.read.mockReturnValueOnce(pending.promise)
    mocks.invoke.mockResolvedValue(result('Current'))
    const provider = new CloudAPIProvider(), onFinal = vi.fn(), onError = vi.fn()
    await provider.connect({onFinal,onError})
    record(provider,1); provider.cancel(); record(provider,2); await settle()
    if (completion === 'resolve') pending.resolve({'cloudAsr.apiKey':'stale'}); else pending.reject(new Error('Secret settings failure'))
    await settle()
    expect(mocks.invoke).toHaveBeenCalledOnce(); expect(onFinal).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled()
  })
  it('reports settings failure only for the current run and hides private error detail', async () => {
    mocks.read.mockRejectedValue(new Error('Secret settings failure'))
    const provider = new CloudAPIProvider(), onError=vi.fn(), onDone=vi.fn()
    await provider.connect({onError,onDone}); record(provider,1); await settle()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Error: Could not read ASR settings')
    expect(onDone).toHaveBeenCalledOnce()
  })
  it('preserves a new configuration started synchronously when an empty run finishes', async () => {
    mocks.invoke.mockResolvedValue(result('Current'))
    const provider = new CloudAPIProvider(), onFinal = vi.fn()
    let next = true
    await provider.connect({onFinal,onDone:()=>{if(next){next=false; record(provider,2)}}})
    provider.start({runId:1}); provider.stop(); await settle()
    expect(mocks.invoke).toHaveBeenCalledOnce(); expect(onFinal).toHaveBeenCalledOnce()
  })
})
