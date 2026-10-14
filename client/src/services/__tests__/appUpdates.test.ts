import { beforeEach, describe, expect, it, vi } from 'vitest'
import { showUpdatePrompt } from '@/components/updatePromptState'

const mock = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  check: vi.fn(),
  reserve: vi.fn(() => true),
  release: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mock.isTauri, invoke: mock.invoke }))
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
  mock.invoke.mockResolvedValue(undefined)
})

describe('optional signed updates', () => {
  it('does not launch an installer that exits the app when output restoration fails', async () => {
    const update = release()
    mock.check.mockResolvedValue(update)
    mock.invoke.mockImplementation((command) => command === 'restore_system_output'
      ? Promise.reject(new Error('Synthetic output restore failure')) : Promise.resolve())
    const manager = await updates()
    await manager.checkForUpdates()
    await manager.installAvailableUpdate()
    expect(update.install).not.toHaveBeenCalled()
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'error', errorStage: 'install' })
    expect(mock.release).toHaveBeenCalledOnce()
  })

  it('keeps a timeout cause in the permanent log and gives a useful manual error without exposing payloads', async () => {
    const manager = await updates()
    mock.check.mockRejectedValueOnce(new Error('HTTP 504: request timed out; api_key=SYNTHETIC_SECRET; response=SYNTHETIC_PRIVATE_TEXT'))
    await manager.checkForUpdates(true)
    expect(manager.getUpdateStatus()).toMatchObject({
      phase: 'error', errorStage: 'check', errorMessage: expect.stringMatching(/timed out/i),
    })
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('append_debug_log', {
      payload: expect.objectContaining({ source: 'update', detail: expect.objectContaining({
        operation: 'check', error: expect.objectContaining({ kind: 'timeout', httpStatus: 504 }),
      }) }),
    }))
    const logs = JSON.stringify(mock.invoke.mock.calls)
    expect(logs).not.toContain('SYNTHETIC_SECRET')
    expect(logs).not.toContain('SYNTHETIC_PRIVATE_TEXT')
  })

  it('records an automatic DNS failure without opening an update error prompt', async () => {
    const manager = await updates()
    mock.check.mockRejectedValueOnce(new Error('DNS resolution failed for https://synthetic.invalid/?token=SYNTHETIC_SECRET'))
    await manager.checkForUpdates()
    expect(manager.getUpdateStatus().phase).toBe('idle')
    expect(showUpdatePrompt(manager.getUpdateStatus(), true, true)).toBe(false)
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('append_debug_log', {
      payload: expect.objectContaining({ source: 'update', detail: expect.objectContaining({
        operation: 'check', error: expect.objectContaining({ kind: 'network', reason: 'dns' }),
      }) }),
    }))
    expect(JSON.stringify(mock.invoke.mock.calls)).not.toContain('SYNTHETIC_SECRET')
  })

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

  it('retains the explicit retry failure when GitHub goes offline after a failed install', async () => {
    const update = release()
    update.install.mockRejectedValueOnce(new Error('Synthetic installation error'))
    mock.check.mockResolvedValueOnce(update).mockRejectedValueOnce(new Error('Synthetic GitHub outage'))
    const manager = await updates()
    await manager.checkForUpdates()
    await manager.installAvailableUpdate()
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'error', errorStage: 'install' })
    await manager.checkForUpdates(true)
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'error', errorStage: 'check' })
    expect(showUpdatePrompt(manager.getUpdateStatus(), true, true)).toBe(true)
  })

  it('does not call native updater APIs in the browser', async () => {
    mock.isTauri.mockReturnValue(false)
    const manager = await updates()
    await manager.checkForUpdates(true)
    expect(mock.check).not.toHaveBeenCalled()
    expect(manager.getUpdateStatus().phase).toBe('idle')
  })
})
