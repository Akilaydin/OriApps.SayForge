import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinalResult } from '../../transcription/types'
import type { ProbeResult } from '../PasteService'

const mocks = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), transform: vi.fn(), emit: vi.fn() }))
vi.mock('../../store', () => ({
  addHistory: mocks.add, deleteHistory: mocks.remove, updateHistoryRecord: vi.fn(),
  getSetting: (_key: string, fallback: unknown) => Promise.resolve(fallback),
}))
vi.mock('../../bridge', () => ({ emit: mocks.emit }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../transcription', () => ({ getProvider: () => ({ mode: 'cloud_api' }) }))
vi.mock('../../textPostProcess', () => ({ applyTextTransforms: mocks.transform }))
import { RecorderOrchestrator } from '../RecorderOrchestrator'

const context = () => ({
  runId: 1, timedOutAt: Date.now(), settled: false, audioDurationSec: 1, wallTimeSec: 1,
  promptResolution: null, appContext: null, probeResult: null,
})
const result: FinalResult = { asrText: 'Synthetic source', llmText: 'Synthetic text', asrMs: 10, llmMs: 0, durationSec: 1 }
const options = { allowInsertionWhenIdle: false, source: 'processing' as const }

// Exercise orchestration while native capture, storage and insertion remain synthetic.
interface TestRecorder {
  activeRunId: number
  state: string
  timedOutProcessingContext: ReturnType<typeof context> | null
  processFinalResult: (result: FinalResult, snapshot: ReturnType<typeof context>, settings: typeof options) => Promise<void>
  handleTextInsertion: (text: string, options: { runId: number; probeResult?: ProbeResult | null }) => Promise<void>
  showFallbackAndReset: (text: string, reason: string, runId: number) => void
  markRunCanceled: (runId: number) => void
  consumeTimedOutProcessingContext: () => ReturnType<typeof context> | null
}

function session() {
  const recorder = new RecorderOrchestrator() as unknown as TestRecorder
  recorder.activeRunId = 1
  recorder.state = 'processing'
  return recorder
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.add.mockResolvedValue(undefined)
  mocks.remove.mockResolvedValue(undefined)
  mocks.transform.mockImplementation((text: string) => Promise.resolve(text))
})

describe('final result isolation after removing the audio archive', () => {
  it('persists text without an audio path and forwards it to insertion', async () => {
    const recorder = session(), insert = vi.spyOn(recorder, 'handleTextInsertion').mockResolvedValue(undefined)
    await recorder.processFinalResult(result, context(), options)
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ llmText: 'Synthetic text', charCount: 14 }))
    expect(mocks.add.mock.calls[0][0]).not.toHaveProperty('audioFilePath')
    expect(insert).toHaveBeenCalledWith('Synthetic text', expect.objectContaining({ runId: 1 }))
  })

  it('removes only the pending history entry when canceled during a storage write', async () => {
    let finish!: () => void, started!: () => void
    const writing = new Promise<void>((resolve) => { started = resolve })
    mocks.add.mockImplementation(() => { started(); return new Promise<void>((resolve) => { finish = resolve }) })
    const recorder = session(), insert = vi.spyOn(recorder, 'handleTextInsertion').mockResolvedValue(undefined)
    const pending = recorder.processFinalResult(result, context(), options)
    await writing
    recorder.markRunCanceled(1)
    recorder.activeRunId = 0
    finish()
    await pending
    expect(mocks.remove).toHaveBeenCalledWith(mocks.add.mock.calls[0][0].id)
    expect(insert).not.toHaveBeenCalled()
  })

  it('ignores a result overtaken by a new run during text processing', async () => {
    let finish!: (text: string) => void
    mocks.transform.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const recorder = session(), insert = vi.spyOn(recorder, 'handleTextInsertion').mockResolvedValue(undefined)
    const pending = recorder.processFinalResult(result, context(), options)
    recorder.activeRunId = 2
    finish('Late text')
    await pending
    expect(mocks.add).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('still inserts useful text if history storage fails', async () => {
    mocks.add.mockRejectedValue(new Error('Synthetic storage failure'))
    const recorder = session(), insert = vi.spyOn(recorder, 'handleTextInsertion').mockResolvedValue(undefined)
    await recorder.processFinalResult(result, context(), options)
    expect(insert).toHaveBeenCalledWith('Synthetic text', expect.objectContaining({ runId: 1 }))
  })

  it('offers the text as a fallback for a non-editable captured target', async () => {
    const recorder = session(), fallback = vi.spyOn(recorder, 'showFallbackAndReset').mockImplementation(() => {})
    await recorder.handleTextInsertion('Synthetic text', { runId: 1, probeResult: { editable: false, hwnd: '0', process: '-', detail: 'synthetic' } })
    expect(fallback).toHaveBeenCalledWith('Synthetic text', 'not_editable', 1)
  })

  it('accepts only a recent timeout context from the current run', () => {
    const recorder = session()
    recorder.timedOutProcessingContext = { ...context(), runId: 2 }
    expect(recorder.consumeTimedOutProcessingContext()).toBeNull()
    recorder.timedOutProcessingContext = { ...context(), timedOutAt: Date.now() - 16000 }
    expect(recorder.consumeTimedOutProcessingContext()).toBeNull()
    const recent = context()
    recorder.timedOutProcessingContext = recent
    expect(recorder.consumeTimedOutProcessingContext()).toBe(recent)
    expect(recent.settled).toBe(true)
    expect(recorder.consumeTimedOutProcessingContext()).toBeNull()
  })
})
