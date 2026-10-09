import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  getSetting: vi.fn(),
  physicalStates: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit }))
vi.mock('../bridge', () => ({ getPTTPhysicalKeyStates: mocks.physicalStates }))
vi.mock('../store', () => ({ getSetting: mocks.getSetting }))

import {
  setShortcutCaptureActive,
  startWebviewKeyboardFallback,
  stopWebviewKeyboardFallback,
} from '../webviewKeyboardFallback'

let documentTarget: EventTarget
let windowTarget: EventTarget

function key(type: 'keydown' | 'keyup', code: string) {
  const event = Object.assign(new Event(type, { cancelable: true }), { code })
  documentTarget.dispatchEvent(event)
  return event
}

describe('working keyboard fallback after removing PTT Lab', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    documentTarget = new EventTarget()
    windowTarget = new EventTarget()
    vi.stubGlobal('document', documentTarget)
    vi.stubGlobal('window', windowTarget)
    mocks.getSetting.mockImplementation(async (setting: string) => (
      setting === 'shortcutPTT' ? 'ControlLeft' : 'AltRight'
    ))
    await startWebviewKeyboardFallback()
    setShortcutCaptureActive(false)
  })

  afterEach(() => {
    stopWebviewKeyboardFallback()
    vi.unstubAllGlobals()
  })

  it('emits one PTT press and release despite key repeats', () => {
    key('keydown', 'ControlLeft')
    key('keydown', 'ControlLeft')
    key('keyup', 'ControlLeft')
    expect(mocks.emit.mock.calls.map(([event]) => event)).toEqual(['ptt-down', 'ptt-up'])
  })

  it('leaves the former lab key available when it is not a configured shortcut', () => {
    expect(key('keydown', 'ControlRight').defaultPrevented).toBe(false)
    expect(key('keyup', 'ControlRight').defaultPrevented).toBe(false)
    expect(mocks.emit).not.toHaveBeenCalled()
  })

  it('toggles hands-free once per press and rearms after release', () => {
    key('keydown', 'AltRight')
    key('keydown', 'AltRight')
    key('keyup', 'AltRight')
    key('keydown', 'AltRight')
    expect(mocks.emit.mock.calls.map(([event]) => event)).toEqual([
      'toggle-hands-free', 'toggle-hands-free',
    ])
  })

  it('releases active PTT on blur and suppresses recording during shortcut capture', () => {
    key('keydown', 'ControlLeft')
    windowTarget.dispatchEvent(new Event('blur'))
    key('keyup', 'ControlLeft')
    setShortcutCaptureActive(true)
    key('keydown', 'ControlLeft')
    expect(mocks.emit.mock.calls.map(([event]) => event)).toEqual(['ptt-down', 'ptt-up'])
  })
})
