import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotificationController } from '../notificationController'
import type { AutoUpdateState } from '../autoUpdate'
import type { UpdateNotificationSnapshot } from '../notificationTypes'

function fixture() {
  let state: AutoUpdateState = { phase: 'idle', pending: null }
  let idle = true
  let theme = 'light'
  const publish = vi.fn<(snapshot: UpdateNotificationSnapshot) => Promise<void>>().mockResolvedValue()
  const install = vi.fn<() => Promise<void>>().mockResolvedValue()
  const onError = vi.fn()
  const controller = new UpdateNotificationController({
    readUpdate: () => state,
    isIdle: () => idle,
    appearance: () => ({ theme, locale: 'en', currentVersion: '0.2.1' }),
    publish,
    install,
    onError,
  })
  const tick = async (time: number) => {
    vi.setSystemTime(time)
    controller.tick()
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  return {
    controller, publish, install, onError, tick,
    update: (next: Partial<AutoUpdateState>) => { state = { ...state, ...next } },
    setIdle: (value: boolean) => { idle = value },
    setTheme: (value: string) => { theme = value },
    last: () => publish.mock.calls[publish.mock.calls.length - 1]?.[0].data,
  }
}

const pending = { version: '0.2.2', filePath: 'C:/Temp/SayIt-0.2.2.exe' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe('desktop update notification', () => {
  it('stays hidden during download and shows only a downloaded package after an idle grace period', async () => {
    const f = fixture()
    f.update({ phase: 'downloading' })
    await f.tick(0)
    await f.tick(2000)
    expect(f.last()).toBeNull()
    f.update({ phase: 'idle', pending })
    await f.tick(2500)
    expect(f.last()?.version).toBe('0.2.2')
    expect(f.install).not.toHaveBeenCalled()
  })

  it('restores a pending package even when a background check is running', async () => {
    const f = fixture()
    f.update({ phase: 'checking', pending })
    await f.tick(0)
    await f.tick(2000)
    expect(f.last()?.version).toBe('0.2.2')
    const calls = f.publish.mock.calls.length
    f.update({ phase: 'idle' })
    await f.tick(2500)
    expect(f.publish).toHaveBeenCalledTimes(calls)
  })

  it('defers recording and processing, then waits two seconds of uninterrupted idle', async () => {
    const f = fixture()
    f.update({ pending })
    f.setIdle(false)
    await f.tick(0)
    await f.tick(5000)
    expect(f.last()).toBeNull()
    f.setIdle(true)
    await f.tick(5500)
    await f.tick(7000)
    expect(f.last()).toBeNull()
    await f.tick(7500)
    expect(f.last()?.version).toBe('0.2.2')
    f.setIdle(false)
    await f.tick(8000)
    expect(f.last()).toBeNull()
    await f.controller.act({ action: 'install', version: pending.version })
    expect(f.install).not.toHaveBeenCalled()
  })

  it('dismisses a version for this session without removing its package or suppressing a newer version', async () => {
    const f = fixture()
    f.update({ pending })
    await f.tick(0)
    await f.tick(2000)
    await f.controller.act({ action: 'later', version: pending.version })
    await f.tick(2500)
    expect(f.last()).toBeNull()
    f.update({ phase: 'checking' })
    await f.tick(6 * 60 * 60 * 1000)
    expect(f.last()).toBeNull()
    f.update({ pending: { ...pending, version: '0.2.3' } })
    await f.tick(6 * 60 * 60 * 1000 + 500)
    expect(f.last()?.version).toBe('0.2.3')
    expect(f.install).not.toHaveBeenCalled()
  })

  it('ignores stale version clicks and serializes repeated install clicks', async () => {
    const f = fixture()
    f.update({ pending })
    await f.controller.act({ action: 'install', version: '0.2.0' })
    expect(f.install).not.toHaveBeenCalled()
    let finish!: () => void
    f.install.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = f.controller.act({ action: 'install', version: pending.version })
    await f.controller.act({ action: 'install', version: pending.version })
    expect(f.install).toHaveBeenCalledTimes(1)
    finish()
    await first
  })

  it('keeps installation failures visible and synchronizes theme changes', async () => {
    const f = fixture()
    f.update({ pending })
    await f.tick(0)
    await f.tick(2000)
    f.update({ installError: 'installer unavailable' })
    f.setTheme('dark')
    await f.tick(2500)
    expect(f.last()).toMatchObject({ installFailed: true, theme: 'dark' })
    f.update({ pending: null })
    await f.tick(3000)
    expect(f.last()).toBeNull()
  })

  it('retries native failures and clears the window when stopped', async () => {
    const f = fixture()
    f.update({ pending })
    await f.tick(0)
    f.publish.mockRejectedValueOnce(new Error('webview creation failed'))
    await f.tick(2000)
    expect(f.onError).toHaveBeenCalledTimes(1)
    await f.tick(2500)
    expect(f.last()?.version).toBe('0.2.2')
    f.controller.stop()
    await f.tick(3000)
    expect(f.last()).toBeNull()
    await f.controller.act({ action: 'install', version: pending.version })
    expect(f.install).not.toHaveBeenCalled()
  })

  it('queues dismissal after a slow native creation so the final state stays hidden', async () => {
    const f = fixture()
    f.update({ pending })
    await f.tick(0)
    let finish!: () => void
    f.publish.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await f.tick(2000)
    await f.controller.act({ action: 'later', version: pending.version })
    finish()
    await f.tick(2500)
    expect(f.last()).toBeNull()
  })
})
