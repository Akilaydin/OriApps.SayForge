import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ settings: new Map<string, unknown>() }))
vi.mock('../../store', () => ({
  getSetting: (key: string, fallback: unknown) =>
    Promise.resolve(mocks.settings.has(key) ? mocks.settings.get(key) : fallback),
}))
vi.mock('../../aiPrompt', () => ({
  getAiPrompt: () => Promise.resolve(''),
  buildHotwordInjectionPart: () => null,
}))
vi.mock('../../bridge', () => ({ updateOverlay: vi.fn() }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../transcription', () => ({ getProvider: () => ({ mode: 'cloud_api' }) }))

import { RecorderOrchestrator } from '../RecorderOrchestrator'

type GainSnapshot = {
  micGainEnabled: boolean
  micGainDb: number
}

beforeEach(() => mocks.settings.clear())

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
})
