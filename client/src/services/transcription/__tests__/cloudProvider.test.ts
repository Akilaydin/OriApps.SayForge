import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), settings: new Map<string, unknown>() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/store', () => ({ getSetting: (key: string, fallback: unknown) => Promise.resolve(mocks.settings.get(key) ?? fallback) }))
vi.mock('@/services/bridge', () => ({ notifyAsrCapabilityMaybeChanged: vi.fn() }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn(), AI_LOG_SOURCE: 'ai', AI_EVENT_OUTCOME: 'outcome', AI_EVENT_REQUEST: 'request' }))
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
  expect(provider.start({ runId, aiConfig: { workMode: 'cloud_api', aiEnabled: false, aiMinDurationSec: 0 }, ...patch })).toBe(true)
  provider.sendAudio(new ArrayBuffer(16000))
  expect(provider.stop()).toBe(true)
}

beforeEach(() => { mocks.invoke.mockReset(); mocks.settings.clear() })
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
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ asrText:'Synthetic text',llmText:'Synthetic text' }))
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
})
