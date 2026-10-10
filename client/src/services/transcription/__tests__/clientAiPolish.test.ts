import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({invoke:mocks.invoke}))
vi.mock('../../store', () => ({getSetting: (key: string) => Promise.resolve({
  'cloudAi.provider':'openai_compat','cloudAi.apiUrl':'https://ai.example/v1',
  'cloudAi.apiKey':'test','cloudAi.model':'custom',
}[key as 'cloudAi.provider'])}))
vi.mock('../../debugLog', () => ({addRuntimeEvent:vi.fn(),AI_LOG_SOURCE:'ai',AI_EVENT_REQUEST:'request',AI_EVENT_OUTCOME:'outcome'}))
import { polishWithClientAi, isClientAiConfigComplete } from '../clientAiPolish'
import { resolveAiPolicy } from '../aiPolicy'
import { addRuntimeEvent } from '../../debugLog'
const options = () => ({asrText:'Synthetic transcript',policy:resolveAiPolicy({workMode:'cloud_api',aiEnabled:true,aiMinDurationSec:0,audioDurationSec:1}),outcomeContext:{operationId:Math.random().toString(),trigger:'live' as const},logSource:'test'})
beforeEach(() => { mocks.invoke.mockReset(); vi.mocked(addRuntimeEvent).mockClear() })
afterEach(() => vi.useRealTimers())
describe('optional client AI failure and cancellation', () => {
  it('keeps the transcript when AI fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('Synthetic network failure'))
    expect(await polishWithClientAi(options())).toMatchObject({llmText:'Synthetic transcript',aiStatus:'failed',aiReason:'call_failed'})
  })
  it('does not persist provider-echoed private data on AI failure', async () => {
    mocks.invoke.mockRejectedValue(new Error('HTTP 401 sk-synthetic-secret private transcript and editor context'))
    expect(await polishWithClientAi(options())).toMatchObject({llmText:'Synthetic transcript',aiStatus:'failed'})
    const events = vi.mocked(addRuntimeEvent).mock.calls
    const warn = events.find(([level]) => level === 'warn')
    expect(warn?.[3]).toMatchObject({ errorCode: 'request_failed', provider: 'openai_compat' })
    expect(JSON.stringify(events)).not.toContain('synthetic-secret')
    expect(JSON.stringify(events)).not.toContain('editor context')
  })
  it('keeps the transcript when AI reaches its timeout', async () => {
    vi.useFakeTimers(); mocks.invoke.mockReturnValue(new Promise(() => {}))
    const pending = polishWithClientAi(options())
    await vi.advanceTimersByTimeAsync(8000)
    expect(await pending).toMatchObject({llmText:'Synthetic transcript',aiStatus:'failed',aiReason:'call_timeout'})
  })
  it('ignores an AI response after cancellation', async () => {
    let finish!: (v: {text:string;elapsed_ms:number}) => void
    mocks.invoke.mockReturnValue(new Promise((resolve) => {finish=resolve}))
    let current = true
    const pending = polishWithClientAi({...options(),isCurrent:()=>current})
    for(let i=0;i<10;i++) await Promise.resolve()
    current=false; finish({text:'Late text',elapsed_ms:10})
    expect(await pending).toBeNull()
  })
  it('rejects retired Ollama configuration', () => {
    expect(isClientAiConfigComplete({provider:'ollama',apiUrl:'http://127.0.0.1:11434',apiKey:'',model:'old'})).toBe(false)
  })
})
