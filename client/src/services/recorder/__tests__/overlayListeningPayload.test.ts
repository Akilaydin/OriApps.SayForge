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
  getLocale: () => 'zh-CN',
  t: (key: string) => key,
}))

import { OverlayService } from '../OverlayService'

type Payload = Record<string, unknown>

function payloadsFrom(): Payload[] {
  return mocks.updateOverlay.mock.calls.map((call) => call[0] as Payload)
}

describe('listening 更新必须始终携带布局判据', () => {
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

  it.each(emitters)('%s 带上 streaming 与 streamingText', (_name, emit) => {
    const service = new OverlayService(() => 7)
    service.setStreamingActive(true)
    service.setStreamingText('实时字幕中')

    emit(service)

    const payloads = payloadsFrom()
    expect(payloads.length).toBeGreaterThan(0)
    for (const payload of payloads) {
      expect(payload).toMatchObject({
        state: 'listening',
        streaming: true,
        streamingText: '实时字幕中',
      })
    }
  })

  it.each(emitters)('%s 在未开启流式时不硬塞 streaming 字段', (_name, emit) => {
    const service = new OverlayService(() => 7)
    service.setStreamingActive(false)

    emit(service)

    for (const payload of payloadsFrom()) {
      expect(payload.state).toBe('listening')
      expect('streaming' in payload).toBe(false)
    }
  })

  it('所有 listening 出口都经由 listeningPayload，而非各自复制一份', () => {
    const service = new OverlayService(() => 7)
    const spy = vi.spyOn(
      service as unknown as { listeningPayload: (overrides?: Record<string, unknown>) => unknown },
      'listeningPayload',
    )
    service.setStreamingActive(true)

    for (const [name, emit] of emitters) {
      spy.mockClear()
      emit(service)
      expect(spy, `${name} 绕过了 listeningPayload`).toHaveBeenCalled()
    }
  })
})
