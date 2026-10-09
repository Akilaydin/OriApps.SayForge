import { describe, expect, it, vi } from 'vitest'

vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
import { RecorderOrchestrator } from '../RecorderOrchestrator'

type GuardFields = {
  state: 'idle' | 'recording' | 'processing'
  activeRunId: number
  startRecordingLock: boolean
  textInsertionInFlight: boolean
  finalizingLateRunId: number
  timedOutProcessingContext: object | null
  lateResultRunId: number
  activeFallbackToken: number
}

describe('update installer recorder reservation', () => {
  it('reserves the idle state once and releases the guard after a failed install', () => {
    const recorder = new RecorderOrchestrator()
    expect(recorder.beginUpdateInstallation()).toBe(true)
    expect(recorder.beginUpdateInstallation()).toBe(false)
    recorder.endUpdateInstallation()
    expect(recorder.beginUpdateInstallation()).toBe(true)
    recorder.endUpdateInstallation()
  })

  it.each([
    ['recording', { state: 'recording' }],
    ['processing', { state: 'processing' }],
    ['initializing microphone', { startRecordingLock: true }],
    ['running session', { activeRunId: 42 }],
    ['inserting text', { textInsertionInFlight: true }],
    ['late final', { finalizingLateRunId: 42 }],
    ['late result pending', { timedOutProcessingContext: {} }],
    ['late result card', { lateResultRunId: 42 }],
    ['unsaved copyable card', { activeFallbackToken: 42 }],
  ] as const)('does not exit during %s', (_, busy) => {
    const recorder = new RecorderOrchestrator()
    Object.assign(recorder as unknown as GuardFields, busy)
    expect(recorder.beginUpdateInstallation()).toBe(false)
  })
})
