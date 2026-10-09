import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  getRecordingContext: vi.fn(),
  startCapture: vi.fn(),
  provider: {
    mode: 'cloud_api',
    isReady: vi.fn(() => true),
    connect: vi.fn(async () => {}),
    start: vi.fn(() => true),
    cancel: vi.fn(),
    disconnect: vi.fn(),
  },
}))
vi.mock('../../store', () => ({
  getSetting: (key: string, fallback: unknown) =>
    Promise.resolve(mocks.settings.has(key) ? mocks.settings.get(key) : fallback),
}))
vi.mock('../../aiPrompt', () => ({
  getAiPrompt: () => Promise.resolve(''),
  buildHotwordInjectionPart: () => null,
}))
vi.mock('../../bridge', () => ({
  updateOverlay: vi.fn(),
  presentOverlay: vi.fn(),
  setEscapeActionMode: vi.fn(async () => {}),
  getRecordingContext: mocks.getRecordingContext,
}))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../transcription', () => ({ getProvider: () => mocks.provider }))
vi.mock('../../audio', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../audio')>(),
  startCapture: mocks.startCapture,
  stopCapture: vi.fn(async () => {}),
}))
vi.mock('../../textInsertion', () => ({
  captureActiveInsertionTarget: vi.fn(() => null),
  clearCapturedInsertionTarget: vi.fn(),
  startInsertionTargetTracking: vi.fn(),
  stopInsertionTargetTracking: vi.fn(),
}))

import { RecorderOrchestrator } from '../RecorderOrchestrator'

type GainSnapshot = {
  micGainEnabled: boolean
  micGainDb: number
}

beforeEach(() => {
  mocks.settings.clear()
  vi.clearAllMocks()
  mocks.startCapture.mockResolvedValue({ deviceId: 'default', groupId: '', label: '', devices: [] })
})

describe('recorder microphone gain settings', () => {
  it('uses enabled +6 dB for existing installations without stored gain options', async () => {
    const recorder = new RecorderOrchestrator()
    await recorder.refreshRuntimeSettings()
    const settings = recorder as unknown as GainSnapshot
    expect(settings.micGainEnabled).toBe(true)
    expect(settings.micGainDb).toBe(6)
  })

  it('loads the saved disabled state and keeps the selected gain value', async () => {
    mocks.settings.set('micGainEnabled', false)
    mocks.settings.set('micGainDb', 13)
    const recorder = new RecorderOrchestrator()
    await recorder.refreshRuntimeSettings()
    const settings = recorder as unknown as GainSnapshot
    expect(settings.micGainEnabled).toBe(false)
    expect(settings.micGainDb).toBe(13)
  })

  it('normalizes damaged saved values without using extreme gain', async () => {
    mocks.settings.set('micGainEnabled', 'true')
    mocks.settings.set('micGainDb', 200)
    const recorder = new RecorderOrchestrator()
    await recorder.refreshRuntimeSettings()
    const settings = recorder as unknown as GainSnapshot
    expect(settings.micGainEnabled).toBe(false)
    expect(settings.micGainDb).toBe(18)
    mocks.settings.set('micGainDb', 'bad data')
    await recorder.refreshRuntimeSettings()
    expect(settings.micGainDb).toBe(6)
  })

  it('retains the starting gain while recording setup awaits editor context', async () => {
    let resolveContext!: (value: unknown) => void
    mocks.getRecordingContext.mockReturnValue(new Promise((resolve) => { resolveContext = resolve }))

    const recorder = new RecorderOrchestrator() as unknown as {
      refreshRuntimeSettings: () => Promise<void>
      startRecording: () => Promise<void>
      checkConfiguredMicMuted: () => Promise<void>
      checkMicMuted: () => Promise<void>
      overlayService: {
        showWaiting: () => void
        startListeningTicker: () => void
        showMicSourceHint: () => void
      }
    }
    vi.spyOn(recorder, 'checkConfiguredMicMuted').mockResolvedValue(undefined)
    vi.spyOn(recorder, 'checkMicMuted').mockResolvedValue(undefined)
    vi.spyOn(recorder.overlayService, 'showWaiting').mockImplementation(() => {})
    vi.spyOn(recorder.overlayService, 'startListeningTicker').mockImplementation(() => {})
    vi.spyOn(recorder.overlayService, 'showMicSourceHint').mockImplementation(() => {})

    await recorder.refreshRuntimeSettings() // enabled +6 dB at run entry
    const run = recorder.startRecording()
    expect(mocks.getRecordingContext).toHaveBeenCalledOnce()
    expect(mocks.startCapture).not.toHaveBeenCalled()

    mocks.settings.set('micGainEnabled', false)
    mocks.settings.set('micGainDb', 13)
    await recorder.refreshRuntimeSettings() // new values arrive while the old run is pending

    resolveContext({
      appContext: null,
      probe: { probeId: 'test', hwnd: '0', focusHwnd: '0', editable: true, process: 'test', verdict: 'ok' },
    })
    await run
    expect(mocks.startCapture).toHaveBeenCalledOnce()
    expect(mocks.startCapture.mock.calls[0][5]).toEqual({ enabled: true, db: 6 })
  })
})
