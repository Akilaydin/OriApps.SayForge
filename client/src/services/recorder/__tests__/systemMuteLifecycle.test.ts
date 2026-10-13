import { beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ mute: vi.fn(), restore: vi.fn() }))
vi.mock('../../bridge', () => ({ muteSystemOutput: mock.mute, restoreSystemOutput: mock.restore }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
import { RecorderOrchestrator } from '../RecorderOrchestrator'

type MuteControl = { applySystemMute(): void; restoreSystemMuteIfNeeded(): void }
beforeEach(() => { vi.resetAllMocks(); mock.mute.mockResolvedValue(true); mock.restore.mockResolvedValue(true) })

it('waits for an in-flight mute before stop/cancel restores output and before updater may exit', async () => {
  let finishMute!: (value: boolean) => void
  mock.mute.mockReturnValue(new Promise<boolean>((resolve) => { finishMute = resolve }))
  const recorder = new RecorderOrchestrator()
  const mute = recorder as unknown as MuteControl
  mute.applySystemMute()
  await vi.waitFor(() => expect(mock.mute).toHaveBeenCalledOnce())
  mute.restoreSystemMuteIfNeeded()
  expect(mock.restore).not.toHaveBeenCalled()
  expect(recorder.beginUpdateInstallation()).toBe(false)
  finishMute(true)
  await vi.waitFor(() => expect(mock.restore).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(recorder.beginUpdateInstallation()).toBe(true))
  recorder.endUpdateInstallation()
})

it('still restores a possibly changed endpoint after mute reports failure', async () => {
  mock.mute.mockRejectedValue(new Error('Synthetic partially applied mute'))
  const recorder = new RecorderOrchestrator()
  const mute = recorder as unknown as MuteControl
  mute.applySystemMute()
  await new Promise((resolve) => setTimeout(resolve, 10))
  mute.restoreSystemMuteIfNeeded()
  await vi.waitFor(() => expect(mock.restore).toHaveBeenCalledOnce())
})

it('serializes a new recording after an outstanding restore without clearing the new mute', async () => {
  let finishRestore!: (value: boolean) => void
  mock.restore.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishRestore = resolve }))
  const recorder = new RecorderOrchestrator()
  const mute = recorder as unknown as MuteControl
  mute.applySystemMute()
  await vi.waitFor(() => expect(mock.mute).toHaveBeenCalledOnce())
  mute.restoreSystemMuteIfNeeded()
  await vi.waitFor(() => expect(mock.restore).toHaveBeenCalledOnce())
  mute.applySystemMute()
  expect(mock.mute).toHaveBeenCalledTimes(1)
  finishRestore(true)
  await vi.waitFor(() => expect(mock.mute).toHaveBeenCalledTimes(2))
  mute.restoreSystemMuteIfNeeded()
  await vi.waitFor(() => expect(mock.restore).toHaveBeenCalledTimes(2))
})
