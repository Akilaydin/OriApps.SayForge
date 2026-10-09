import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateOverlay: vi.fn(),
  presentOverlay: vi.fn(),
}))

vi.mock('../../bridge', () => ({
  updateOverlay: mocks.updateOverlay,
  presentOverlay: mocks.presentOverlay,
  hideOverlay: vi.fn(() => Promise.resolve()),
  setEscapeActionMode: vi.fn(() => Promise.resolve()),
  copyText: vi.fn(() => Promise.resolve()),
}))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../store', () => ({
  getSetting: vi.fn((_key: string, fallback: unknown) => Promise.resolve(fallback)),
}))
vi.mock('@/i18n', () => ({
  getLocale: () => 'en',
  t: (key: string) => key,
}))

import { OverlayService } from '../OverlayService'

type Payload = Record<string, unknown>

function payloadsFrom(): Payload[] {
  return mocks.updateOverlay.mock.calls.map((call) => call[0] as Payload)
}

describe('listening updates retain layout fields', () => {
  const emitters: Array<[string, (service: InstanceType<typeof OverlayService>) => void]> = [
    ['showLowVolumeWarning', (s) => s.showLowVolumeWarning()],
    ['showNoSignalWarning', (s) => s.showNoSignalWarning()],
    ['showMicMutedAlert', (s) => s.showMicMutedAlert()],
    ['clearWarning', (s) => s.clearWarning()],
    ['showTimeoutWarning', (s) => s.showTimeoutWarning()],
    ['pushListeningBars', (s) => s.pushListeningBars([3, 5, 8], true)],
  ]

  beforeEach(() => {
    mocks.updateOverlay.mockClear()
    mocks.presentOverlay.mockClear()
  })

  it.each(emitters)('%s never inserts the retired streaming field', (_name, emit) => {
    const service = new OverlayService(() => 7)

    emit(service)

    for (const payload of payloadsFrom()) {
      expect(payload.state).toBe('listening')
      expect('streaming' in payload).toBe(false)
      expect('streamingText' in payload).toBe(false)
      expect(payload.elapsedSec).toBe(7)
    }
  })

  it('all listening paths use listeningPayload', () => {
    const service = new OverlayService(() => 7)
    const spy = vi.spyOn(
      service as unknown as { listeningPayload: (overrides?: Record<string, unknown>) => unknown },
      'listeningPayload',
    )

    for (const [name, emit] of emitters) {
      spy.mockClear()
      emit(service)
      expect(spy, `${name} bypassed listeningPayload`).toHaveBeenCalled()
    }
  })
})
