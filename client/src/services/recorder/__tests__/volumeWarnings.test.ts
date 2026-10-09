import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecorderOrchestrator } from '../RecorderOrchestrator'
import type { MicLevel } from '../helpers'

vi.mock('../../store', () => ({ getSetting: (_key: string, fallback: unknown) => Promise.resolve(fallback) }))
vi.mock('../../bridge', () => ({ updateOverlay: vi.fn() }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../transcription', () => ({ getProvider: () => ({ mode: 'cloud_api' }) }))

type RecorderVolumeProbe = {
  updateVolumeWarning: (level: MicLevel, sampleCount: number) => void
  overlayService: {
    showLowVolumeWarning: () => void
    showNoSignalWarning: () => void
    clearWarning: () => void
  }
}

function createProbe() {
  const recorder = new RecorderOrchestrator() as unknown as RecorderVolumeProbe
  const showLow = vi.spyOn(recorder.overlayService, 'showLowVolumeWarning').mockImplementation(() => {})
  const showNoSignal = vi.spyOn(recorder.overlayService, 'showNoSignalWarning').mockImplementation(() => {})
  const clear = vi.spyOn(recorder.overlayService, 'clearWarning').mockImplementation(() => {})
  const feed = (level: MicLevel, frames: number) => {
    for (let i = 0; i < frames; i++) recorder.updateVolumeWarning(level, 1600) // 100 ms/frame
  }
  return { feed, showLow, showNoSignal, clear }
}

afterEach(() => vi.restoreAllMocks())

describe('microphone input warnings', () => {
  it('warns after two seconds of weak input before speech starts', () => {
    const { feed, showLow, showNoSignal } = createProbe()
    feed('low', 19)
    expect(showLow).not.toHaveBeenCalled()
    feed('low', 1)
    expect(showLow).toHaveBeenCalledOnce()
    expect(showNoSignal).not.toHaveBeenCalled()
  })

  it('keeps the no-signal warning for an initially silent microphone', () => {
    const { feed, showLow, showNoSignal } = createProbe()
    feed('muted', 20)
    expect(showNoSignal).toHaveBeenCalledOnce()
    expect(showLow).not.toHaveBeenCalled()
  })

  it('never treats normal pauses as low microphone volume after hearing speech', () => {
    const { feed, showLow, showNoSignal } = createProbe()
    feed('voiced', 5) // 0.5s of confirmed speech
    feed('muted', 60)
    feed('low', 60)
    expect(showLow).not.toHaveBeenCalled()
    expect(showNoSignal).not.toHaveBeenCalled()
  })

  it('clears an early warning when speech starts and does not warn again', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { feed, showLow, clear } = createProbe()
    feed('low', 20)
    feed('voiced', 5)
    expect(clear).toHaveBeenCalledOnce()
    clock.mockReturnValue(20_000) // Beyond the five-second rewarning interval
    feed('low', 60)
    expect(showLow).toHaveBeenCalledOnce()
  })

  it('requires consecutive weak input instead of accumulating normal speech gaps', () => {
    const { feed, showLow } = createProbe()
    feed('low', 16)
    feed('voiced', 1)
    feed('low', 16)
    expect(showLow).not.toHaveBeenCalled()
    feed('low', 4)
    expect(showLow).toHaveBeenCalledOnce()
  })
})
