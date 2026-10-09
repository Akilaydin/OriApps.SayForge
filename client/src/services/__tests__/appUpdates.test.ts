import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  check: vi.fn(),
  reserve: vi.fn(() => true),
  release: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mock.isTauri }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mock.check }))
vi.mock('../recorder', () => ({ beginUpdateInstallation: mock.reserve, endUpdateInstallation: mock.release }))

async function updates() {
  // Every test gets a fresh singleton, including the dismissed release and in-flight promises.
  vi.resetModules()
  return import('../appUpdates')
}

function release(version = '0.3.0') {
  return { version, body: 'Synthetic notes', download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  mock.isTauri.mockReturnValue(true)
  mock.reserve.mockReturnValue(true)
})

describe('optional signed updates', () => {
  it('suggests a new version, and Later neither downloads nor suppresses a manual check', async () => {
    const update = release()
    mock.check.mockResolvedValue(update)
    const manager = await updates()
    await manager.checkForUpdates()
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'available', version: update.version })
    manager.postponeUpdate()
    expect(manager.getUpdateStatus().phase).toBe('idle')
    expect(update.close).toHaveBeenCalledTimes(1)
    expect(update.download).not.toHaveBeenCalled()
    expect(update.install).not.toHaveBeenCalled()
    await manager.checkForUpdates()
    expect(manager.getUpdateStatus().phase).toBe('idle')
    await manager.checkForUpdates(true)
    expect(manager.getUpdateStatus().phase).toBe('available')
  })

  it('quietly skips automatic failures but reports manual check failures and no-update results', async () => {
    const manager = await updates()
    mock.check.mockRejectedValueOnce(new Error('Synthetic offline'))
    await manager.checkForUpdates()
    expect(manager.getUpdateStatus().phase).toBe('idle')
    mock.check.mockRejectedValueOnce(new Error('Synthetic offline'))
    await manager.checkForUpdates(true)
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'error', errorStage: 'check' })
    mock.check.mockResolvedValue(null)
    await manager.checkForUpdates(true)
    expect(manager.getUpdateStatus().phase).toBe('up-to-date')
  })

  it('allows only one request while a check is pending', async () => {
    let done!: (value: null) => void
    mock.check.mockReturnValue(new Promise<null>((resolve) => { done = resolve }))
    const manager = await updates()
    const first = manager.checkForUpdates()
    const second = manager.checkForUpdates(true)
    expect(mock.check).toHaveBeenCalledTimes(1)
    done(null)
    await Promise.all([first, second])
    expect(manager.getUpdateStatus().phase).toBe('up-to-date')
  })

  it('downloads only on approval, waits for an idle recorder, and reserves installation atomically', async () => {
    vi.useFakeTimers()
    const update = release()
    update.download.mockImplementation(async (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      onEvent({ event: 'Progress', data: { chunkLength: 40 } })
    })
    mock.check.mockResolvedValue(update)
    mock.reserve.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    const manager = await updates()
    await manager.checkForUpdates()
    expect(update.download).not.toHaveBeenCalled()
    const installing = manager.installAvailableUpdate()
    await vi.waitFor(() => expect(manager.getUpdateStatus().phase).toBe('waiting'))
    expect(update.download).toHaveBeenCalledTimes(1)
    expect(update.install).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(900)
    await installing
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(mock.release).toHaveBeenCalledTimes(1)
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'installing' })
  })

  it('can cancel while waiting without installing or leaving the recorder reserved', async () => {
    vi.useFakeTimers()
    const update = release()
    mock.check.mockResolvedValue(update)
    mock.reserve.mockReturnValue(false)
    const manager = await updates()
    await manager.checkForUpdates()
    const installing = manager.installAvailableUpdate()
    await vi.waitFor(() => expect(manager.getUpdateStatus().phase).toBe('waiting'))
    manager.cancelPendingInstallation()
    await vi.advanceTimersByTimeAsync(500)
    await installing
    expect(update.install).not.toHaveBeenCalled()
    expect(mock.release).not.toHaveBeenCalled()
    expect(update.close).toHaveBeenCalledTimes(1)
    expect(manager.getUpdateStatus().phase).toBe('idle')
  })

  it('blocks duplicate clicks and releases the recorder after an installer error', async () => {
    const update = release()
    update.install.mockRejectedValue(new Error('Synthetic failed installer'))
    mock.check.mockResolvedValue(update)
    const manager = await updates()
    await manager.checkForUpdates()
    const first = manager.installAvailableUpdate()
    const second = manager.installAvailableUpdate()
    await Promise.all([first, second])
    expect(update.download).toHaveBeenCalledTimes(1)
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(mock.reserve).toHaveBeenCalledTimes(1)
    expect(mock.release).toHaveBeenCalledTimes(1)
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'error', errorStage: 'install' })
  })

  it('does not call native updater APIs in the browser', async () => {
    mock.isTauri.mockReturnValue(false)
    const manager = await updates()
    await manager.checkForUpdates(true)
    expect(mock.check).not.toHaveBeenCalled()
    expect(manager.getUpdateStatus().phase).toBe('idle')
  })
})
