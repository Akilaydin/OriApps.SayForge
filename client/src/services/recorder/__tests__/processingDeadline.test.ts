import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeProcessingTimeoutMs } from '../helpers'

vi.mock('../../audio', () => ({ stopCapture: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../bridge', () => ({ emit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../transcription', () => ({ getProvider: () => ({ mode: 'cloud_api' }) }))
import { RecorderOrchestrator } from '../RecorderOrchestrator'

type Harness = {
  state: string
  activeRunId: number
  audioSentSamples: number
  recordStartPerf: number
  canceledRuns: Set<number>
  timedOutProcessingContext: object | null
  provider: { mode: string; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
  overlayService: ReturnType<typeof overlay>
  stopRecording: () => Promise<void>
  cancelProcessing: (token: number) => void
  failRunWithCard: () => Promise<void>
}

function overlay() {
  return {
    stopListeningTicker: vi.fn(), resetWarnings: vi.fn(), showThinking: vi.fn(),
    showAwaitingLateResult: vi.fn(), showCanceled: vi.fn(),
  }
}

async function session() {
  const recorder = new RecorderOrchestrator() as unknown as Harness
  recorder.state = 'recording'
  recorder.activeRunId = 1
  recorder.audioSentSamples = 16000 * 300
  recorder.recordStartPerf = performance.now()
  Object.defineProperty(recorder, 'provider', { value: {
    mode: 'cloud_api', stop: vi.fn().mockReturnValue(true), cancel: vi.fn(),
  } })
  recorder.overlayService = overlay()
  const failure = vi.spyOn(recorder, 'failRunWithCard').mockResolvedValue(undefined)
  await recorder.stopRecording()
  return { recorder, failure }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('cloud recorder processing deadline', () => {
  it('waits through the native budget and headroom, then expires only after late-result grace', async () => {
    const { recorder, failure } = await session()
    const deadline = computeProcessingTimeoutMs(300, 'cloud_api')
    await vi.advanceTimersByTimeAsync(deadline - 1)
    expect(recorder.state).toBe('processing')
    expect(recorder.provider.cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recorder.overlayService.showAwaitingLateResult).toHaveBeenCalledWith(15, 1)
    expect(recorder.timedOutProcessingContext).not.toBeNull()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(recorder.provider.cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recorder.provider.cancel).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(1, expect.objectContaining({
      failReasonCode: 'processing_timeout', detail: expect.stringContaining('Audio is not saved'),
    }))
  })

  it('user cancellation ends waiting immediately and clears the entire deadline', async () => {
    const { recorder, failure } = await session()
    await vi.advanceTimersByTimeAsync(180_000)
    recorder.cancelProcessing(1)
    expect(recorder.state).toBe('idle')
    expect(recorder.canceledRuns.has(1)).toBe(true)
    expect(recorder.provider.cancel).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(computeProcessingTimeoutMs(300, 'cloud_api') + 15_000)
    expect(recorder.overlayService.showAwaitingLateResult).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
    expect(recorder.provider.cancel).toHaveBeenCalledOnce()
  })

  it('ignores a cancellation token from another run', async () => {
    const { recorder } = await session()
    recorder.cancelProcessing(2)
    expect(recorder.state).toBe('processing')
    expect(recorder.provider.cancel).not.toHaveBeenCalled()
  })
})
