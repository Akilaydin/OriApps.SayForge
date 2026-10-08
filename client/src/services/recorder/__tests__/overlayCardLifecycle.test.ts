import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  presentOverlay: vi.fn((_data: unknown) => Promise.resolve(1)),
  updateOverlay: vi.fn((_data: unknown) => Promise.resolve()),
  hideOverlay: vi.fn(() => Promise.resolve()),
  setEscapeActionMode: vi.fn((_mode: string, _token?: number) => Promise.resolve()),
  setCardHotkeys: vi.fn((_actions: string[], _token?: number) => Promise.resolve()),
}))

vi.mock('../../bridge', () => ({
  presentOverlay: mocks.presentOverlay,
  updateOverlay: mocks.updateOverlay,
  hideOverlay: mocks.hideOverlay,
  setEscapeActionMode: mocks.setEscapeActionMode,
  setCardHotkeys: mocks.setCardHotkeys,
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

const KEEPALIVE_MS = 8000
const NATIVE_TTL_MS = 20000

function newService() {
  return new OverlayService(() => 0)
}

function hotkeyCalls(): Array<[string[], number]> {
  return mocks.setCardHotkeys.mock.calls.map(([actions, token]) => [actions ?? [], token ?? 0])
}

function escapeModes(): string[] {
  return mocks.setEscapeActionMode.mock.calls.map(([mode]) => String(mode))
}

function lastPayload(fn: { mock: { calls: unknown[][] } }): Record<string, unknown> | undefined {
  const calls = fn.mock.calls
  if (calls.length === 0) return undefined
  return calls[calls.length - 1][0] as Record<string, unknown>
}

describe('悬浮窗卡片的生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.presentOverlay.mockClear()
    mocks.updateOverlay.mockClear()
    mocks.hideOverlay.mockClear()
    mocks.setEscapeActionMode.mockClear()
    mocks.setCardHotkeys.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('结果卡永不自动消失', () => {
    const service = newService()
    service.showFallback('今天天气怎么样', 'not_editable', 7)

    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(mocks.hideOverlay).not.toHaveBeenCalled()
  })

  it('失败卡 5 秒后自动收起', () => {
    const service = newService()
    service.showFailure({ title: 'recorder.emptyAfterProcessingTitle', recovery: 'none', token: 8 })

    vi.advanceTimersByTime(4_000)
    expect(mocks.hideOverlay).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(mocks.hideOverlay).toHaveBeenCalled()
  })

  it('识别没出文字时只弹 toast，不建卡片、不接管按键', () => {
    for (const reason of ['silent', 'no_text'] as const) {
      mocks.presentOverlay.mockClear()
      mocks.setEscapeActionMode.mockClear()
      const service = newService()

      service.showNoSpeech(reason, { runId: 1 })

      const states = mocks.presentOverlay.mock.calls
        .map((call) => (call[0] as { state?: string } | undefined)?.state)
      expect(states).toEqual(['toast'])
      expect(states).not.toContain('failure')
      const modes = mocks.setEscapeActionMode.mock.calls.map((call) => call[0])
      expect(modes.every((mode) => mode === 'off')).toBe(true)
    }
  })

  it('卡片可见期间会持续续期，续期间隔小于原生 TTL', () => {
    const service = newService()
    service.showFallback('今天天气怎么样', 'not_editable', 7)

    const initialHotkeys = hotkeyCalls().length
    const initialEscapes = escapeModes().length
    expect(KEEPALIVE_MS).toBeLessThan(NATIVE_TTL_MS)

    vi.advanceTimersByTime(NATIVE_TTL_MS + KEEPALIVE_MS)

    const renewals = hotkeyCalls().length - initialHotkeys
    expect(renewals).toBeGreaterThanOrEqual(Math.floor(NATIVE_TTL_MS / KEEPALIVE_MS))
    expect(escapeModes().length).toBeGreaterThan(initialEscapes)
    for (const [actions, token] of hotkeyCalls()) {
      expect(actions).toEqual(['copy'])
      expect(token).toBe(7)
    }
  })

  it('结果卡注册 Ctrl+C 与 Esc；失败卡只要 Esc', () => {
    const service = newService()
    service.showFallback('今天天气怎么样', 'not_editable', 7)
    expect(hotkeyCalls()[0]).toEqual([['copy'], 7])
    expect(escapeModes()).toContain('dismiss_fallback')

    mocks.setCardHotkeys.mockClear()
    mocks.setEscapeActionMode.mockClear()
    service.showFailure({ title: 'recorder.recognitionFailedTitle', recovery: 'unknown', token: 8 })
    expect(hotkeyCalls().every(([actions]) => actions.length === 0)).toBe(true)
    expect(escapeModes()).toContain('dismiss_fallback')
  })

  it('没有文本的结果卡不注册 Ctrl+C', () => {
    const service = newService()
    service.showFallback('', 'not_editable', 7)
    expect(hotkeyCalls().every(([actions]) => actions.length === 0)).toBe(true)
  })

  it('token=0 的预览卡片不接管任何按键', () => {
    const service = newService()
    service.showFallback('预览文本', 'not_editable', 0)

    expect(hotkeyCalls().every(([actions]) => actions.length === 0)).toBe(true)
    expect(escapeModes().every((mode) => mode === 'off')).toBe(true)

    mocks.setCardHotkeys.mockClear()
    vi.advanceTimersByTime(NATIVE_TTL_MS * 2)
    expect(mocks.setCardHotkeys).not.toHaveBeenCalled()
  })

  it('开始新一轮显示会解除上一张卡片的按键接管', () => {
    const service = newService()
    service.showFallback('今天天气怎么样', 'not_editable', 7)

    mocks.setCardHotkeys.mockClear()
    mocks.setEscapeActionMode.mockClear()
    service.showWaiting()

    expect(hotkeyCalls()).toContainEqual([[], 0])

    mocks.setEscapeActionMode.mockClear()
    service.startListeningTicker(9)
    mocks.setEscapeActionMode.mockClear()
    vi.advanceTimersByTime(KEEPALIVE_MS * 3)
    expect(escapeModes()).not.toContain('dismiss_fallback')

    service.stopListeningTicker()
  })

  it('hide 会解除按键接管', () => {
    const service = newService()
    service.showFallback('今天天气怎么样', 'not_editable', 7)

    mocks.setCardHotkeys.mockClear()
    service.hide()

    expect(hotkeyCalls()).toContainEqual([[], 0])
    expect(escapeModes()).toContain('off')
  })

  it('悬浮窗收起卡片后不再续期', () => {
    const service = newService()
    service.showFallback('今天天气怎么样', 'not_editable', 7)

    service.noteCardDismissed(7)
    mocks.setCardHotkeys.mockClear()
    mocks.setEscapeActionMode.mockClear()

    vi.advanceTimersByTime(KEEPALIVE_MS * 5)
    expect(hotkeyCalls().every(([actions]) => actions.length === 0)).toBe(true)
    expect(escapeModes().every((mode) => mode === 'off')).toBe(true)
  })

  it('关闭回报只认当前卡片', () => {
    const service = newService()
    service.showFallback('第一段', 'not_editable', 7)
    service.showFallback('第二段', 'not_editable', 9)

    mocks.setCardHotkeys.mockClear()
    service.noteCardDismissed(7)

    expect(mocks.setCardHotkeys).not.toHaveBeenCalled()
    vi.advanceTimersByTime(KEEPALIVE_MS + 100)
    expect(hotkeyCalls()).toContainEqual([['copy'], 9])
  })

  it('恢复结论是随后补发的，且只认当前卡片的 token', () => {
    const service = newService()
    service.showFailure({ title: 'recorder.protocolIncompleteTitle', recovery: 'unknown', token: 8 })
    expect(lastPayload(mocks.presentOverlay)).toMatchObject({
      state: 'failure',
      failureRecovery: 'unknown',
    })

    service.updateFailureRecovery('history', 8)
    expect(lastPayload(mocks.updateOverlay)).toMatchObject({
      state: 'failure',
      failureRecovery: 'history',
    })

    mocks.updateOverlay.mockClear()
    service.updateFailureRecovery('history', 7)
    expect(mocks.updateOverlay).not.toHaveBeenCalled()
  })

  it('补发恢复结论时重新带上标题与原因，不留下残缺的最近状态', () => {
    const service = newService()
    service.showFailure({
      title: 'recorder.recognitionFailedTitle',
      detail: 'err.provider.insufficientBalance',
      recovery: 'unknown',
      token: 8,
    })
    service.updateFailureRecovery('history', 8)

    expect(lastPayload(mocks.updateOverlay)).toMatchObject({
      state: 'failure',
      failureTitle: 'recorder.recognitionFailedTitle',
      failureDetail: 'err.provider.insufficientBalance',
      failureRecovery: 'history',
    })
  })

  it('卡片收起后不再把上一张的标题带进新的下发', () => {
    const service = newService()
    service.showFailure({ title: 'recorder.recognitionFailedTitle', detail: '余额不足', recovery: 'none', token: 8 })
    service.hide()

    mocks.presentOverlay.mockClear()
    service.showFailure({ title: 'recorder.processingTimeoutTitle', recovery: 'none', token: 9 })
    expect(lastPayload(mocks.presentOverlay)).toMatchObject({
      failureTitle: 'recorder.processingTimeoutTitle',
      failureDetail: '',
    })
  })

  it('宽限期等待用独立的 Esc 语义', () => {
    const service = newService()
    service.showAwaitingLateResult(15, 11)

    expect(lastPayload(mocks.presentOverlay)).toMatchObject({
      state: 'thinking',
      thinkingNote: 'late',
    })
    expect(escapeModes()).toContain('abandon_late_result')
    expect(hotkeyCalls().every(([actions]) => actions.length === 0)).toBe(true)
  })
})
