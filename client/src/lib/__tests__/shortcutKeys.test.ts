import { describe, expect, it } from 'vitest'
import {
  canonicalizePTTShortcut,
  displayPTTShortcut,
  getAcceleratorShortcutValidationError,
  getPTTShortcutWarning,
  getPTTShortcutValidationError,
  isValidPTTShortcut,
  keyEventToShortcutCandidate,
  parsePTTShortcut,
  PTT_CODE_TO_VK,
  pttShortcutConflictsWithAccelerator,
  pttShortcutHasModifier,
  pttShortcutToAccelerator,
} from '../shortcutKeys'

describe('physical PTT shortcuts', () => {
  it('preserves left/right keys and canonical order', () => {
    const value = canonicalizePTTShortcut('ShiftRight+KeyK+MetaLeft+ControlLeft')
    expect(value).toBe('ControlLeft+MetaLeft+ShiftRight+KeyK')
    expect(parsePTTShortcut(value)).toEqual([
      'ControlLeft',
      'MetaLeft',
      'ShiftRight',
      'KeyK',
    ])
    expect(displayPTTShortcut('ControlLeft+MetaLeft')).toEqual(['Left Ctrl', 'Left Win'])
  })

  it('accepts legacy single keys and modifier combinations', () => {
    expect(isValidPTTShortcut('AltRight')).toBe(true)
    expect(isValidPTTShortcut('CapsLock')).toBe(true)
    expect(isValidPTTShortcut('MButton')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+KeyK')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+MetaLeft')).toBe(true)
    expect(pttShortcutHasModifier('ControlLeft+KeyK')).toBe(true)
    expect(PTT_CODE_TO_VK.MetaLeft).toBe(0x5b)
    expect(PTT_CODE_TO_VK.KeyK).toBe(0x4b)
  })

  //
  it('supports F1 through F24 with consecutive virtual keys', () => {
    for (let n = 1; n <= 24; n += 1) {
      const code = `F${n}`
      expect(PTT_CODE_TO_VK[code], `${code} must exist in the key table`).toBe(0x70 + n - 1)
      expect(isValidPTTShortcut(code), `${code} must be usable as a single PTT key`).toBe(true)
    }
    expect(displayPTTShortcut('F13')).toEqual(['F13'])
    expect(displayPTTShortcut('F24')).toEqual(['F24'])
    expect(isValidPTTShortcut('ControlLeft+F13')).toBe(true)
    expect(isValidPTTShortcut('AltLeft+F13')).toBe(true)
    expect(getPTTShortcutValidationError('AltLeft+F4')).not.toBeNull()
  })

  it('rejects bare Win, letters and dangerous combinations', () => {
    expect(getPTTShortcutValidationError('MetaLeft')).not.toBeNull()
    expect(getPTTShortcutValidationError('KeyK')).not.toBeNull()
    expect(getPTTShortcutValidationError('ControlLeft+KeyK+KeyL')).not.toBeNull()
    expect(getPTTShortcutValidationError('ControlLeft+ControlRight+KeyK')).not.toBeNull()
    expect(getPTTShortcutValidationError('MetaLeft+KeyL')).not.toBeNull()
    expect(getPTTShortcutValidationError('AltLeft+F4')).not.toBeNull()
    expect(getPTTShortcutValidationError('MetaLeft+KeyK')).not.toBeNull()
    expect(getPTTShortcutValidationError('AltLeft+Space')).not.toBeNull()
    expect(isValidPTTShortcut('ControlLeft+MetaLeft')).toBe(true)
  })

  it('rejects Shift in every PTT shortcut', () => {
    expect(isValidPTTShortcut('ShiftRight')).toBe(false)
    expect(isValidPTTShortcut('ShiftLeft')).toBe(false)
    expect(isValidPTTShortcut('ControlLeft+ShiftRight')).toBe(false)
    expect(isValidPTTShortcut('ShiftLeft+KeyK')).toBe(false)
    expect(getPTTShortcutValidationError('ShiftRight')).toContain('Shift')
    expect(isValidPTTShortcut('AltRight')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+KeyK')).toBe(true)
  })

  it('suggests rebinding legacy Shift shortcuts', () => {
    expect(getPTTShortcutWarning('ShiftRight')).toContain('Shift')
    expect(getPTTShortcutWarning('ControlLeft+ShiftLeft')).toContain('Shift')
    expect(getPTTShortcutWarning('AltRight')).toBeNull()
  })

  it('allows Shift for toggle shortcuts', () => {
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Shift+K')).toBeNull()
  })

  it('rejects reserved Windows combinations', () => {
    expect(getAcceleratorShortcutValidationError('Control+Alt+Delete')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Alt+Tab')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Alt+Space')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Control+Shift+Escape')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Super+K')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('CommandOrControl+K')).toBeNull()
  })

  it('detects conflicts with hands-free accelerators', () => {
    expect(pttShortcutToAccelerator('ControlLeft+KeyK')).toBe('CommandOrControl+K')
    expect(
      pttShortcutConflictsWithAccelerator('ControlLeft+KeyK', 'CommandOrControl+K'),
    ).toBe(true)
    expect(pttShortcutConflictsWithAccelerator('ShiftRight', 'ShiftRight')).toBe(true)
    expect(
      pttShortcutConflictsWithAccelerator('ControlLeft+MetaLeft', 'ControlLeft'),
    ).toBe(true)
    expect(
      pttShortcutConflictsWithAccelerator('ControlLeft+MetaLeft', 'CommandOrControl+K'),
    ).toBe(false)
  })
})
describe('keyboard events to shortcut candidates', () => {
  function keyEvent(init: {
    code: string
    key: string
    ctrl?: boolean
    alt?: boolean
    shift?: boolean
    meta?: boolean
  }): KeyboardEvent {
    return {
      code: init.code,
      key: init.key,
      ctrlKey: init.ctrl ?? false,
      altKey: init.alt ?? false,
      shiftKey: init.shift ?? false,
      metaKey: init.meta ?? false,
    } as KeyboardEvent
  }

  it('captures Ctrl+D after the intermediate Ctrl press', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'ControlLeft', key: 'Control', ctrl: true })))
      .toBe('ControlLeft')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'KeyD', key: 'd', ctrl: true })))
      .toBe('CommandOrControl+D')
  })

  it('supports modifier-only shortcuts', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'AltRight', key: 'Alt', alt: true })))
      .toBe('AltRight')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'ControlRight', key: 'Control', ctrl: true })))
      .toBe('ControlRight')
  })

  it('prefers combinations when modifiers accompany a single-key candidate', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Space', key: ' ' }))).toBe('Space')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Space', key: ' ', ctrl: true })))
      .toBe('CommandOrControl+Space')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'F1', key: 'F1' }))).toBe('F1')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'F1', key: 'F1', ctrl: true })))
      .toBe('CommandOrControl+F1')
  })

  it('rejects bare letters and single keys in comboOnly mode', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'KeyD', key: 'd' }))).toBeNull()
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'AltRight', key: 'Alt', alt: true }), { comboOnly: true }))
      .toBeNull()
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'F1', key: 'F1' }), { comboOnly: true }))
      .toBeNull()
    expect(
      keyEventToShortcutCandidate(keyEvent({ code: 'KeyD', key: 'd', ctrl: true, shift: true }), { comboOnly: true }),
    ).toBe('CommandOrControl+Shift+D')
  })
})
