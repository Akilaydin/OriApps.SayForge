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

describe('PTT 物理组合键', () => {
  it('保留左右位置并按固定顺序规范化', () => {
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

  it('兼容旧单键，并接受普通组合与纯修饰组合', () => {
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
  it('F1–F24 全部可用，vk 连续且可单独作为按住说话键', () => {
    for (let n = 1; n <= 24; n += 1) {
      const code = `F${n}`
      expect(PTT_CODE_TO_VK[code], `${code} 应当在按键表里`).toBe(0x70 + n - 1)
      expect(isValidPTTShortcut(code), `${code} 应当可以单独当按住说话键`).toBe(true)
    }
    expect(displayPTTShortcut('F13')).toEqual(['F13'])
    expect(displayPTTShortcut('F24')).toEqual(['F24'])
    expect(isValidPTTShortcut('ControlLeft+F13')).toBe(true)
    expect(isValidPTTShortcut('AltLeft+F13')).toBe(true)
    expect(getPTTShortcutValidationError('AltLeft+F4')).not.toBeNull()
  })

  it('拒绝单独 Win、裸字母、多主键和危险系统组合', () => {
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

  it('按住说话一律拒绝 Shift，单键和组合成员都算', () => {
    expect(isValidPTTShortcut('ShiftRight')).toBe(false)
    expect(isValidPTTShortcut('ShiftLeft')).toBe(false)
    expect(isValidPTTShortcut('ControlLeft+ShiftRight')).toBe(false)
    expect(isValidPTTShortcut('ShiftLeft+KeyK')).toBe(false)
    expect(getPTTShortcutValidationError('ShiftRight')).toContain('Shift')
    expect(isValidPTTShortcut('AltRight')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+KeyK')).toBe(true)
  })

  it('已保存的 Shift 旧配置给出改绑提示', () => {
    expect(getPTTShortcutWarning('ShiftRight')).toContain('Shift')
    expect(getPTTShortcutWarning('ControlLeft+ShiftLeft')).toContain('Shift')
    expect(getPTTShortcutWarning('AltRight')).toBeNull()
  })

  it('按一下的快捷键不受 Shift 限制', () => {
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Shift+K')).toBeNull()
  })

  it('通用组合键同样拒绝 Windows 保留快捷键', () => {
    expect(getAcceleratorShortcutValidationError('Control+Alt+Delete')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Alt+Tab')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Alt+Space')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Control+Shift+Escape')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Super+K')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('CommandOrControl+K')).toBeNull()
  })

  it('可与免提 accelerator 做语义冲突比较', () => {
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
describe('按键事件 → 候选快捷键', () => {
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

  it('Ctrl+D 录成组合键，中途单按 Ctrl 只是尚未成型', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'ControlLeft', key: 'Control', ctrl: true })))
      .toBe('ControlLeft')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'KeyD', key: 'd', ctrl: true })))
      .toBe('CommandOrControl+D')
  })

  it('修饰键单键仍然可用（免提默认就是右 Alt）', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'AltRight', key: 'Alt', alt: true })))
      .toBe('AltRight')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'ControlRight', key: 'Control', ctrl: true })))
      .toBe('ControlRight')
  })

  it('同时属于单键白名单的键，带修饰时优先当组合键', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Space', key: ' ' }))).toBe('Space')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Space', key: ' ', ctrl: true })))
      .toBe('CommandOrControl+Space')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'F1', key: 'F1' }))).toBe('F1')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'F1', key: 'F1', ctrl: true })))
      .toBe('CommandOrControl+F1')
  })

  it('裸字母不成型；comboOnly 下单键一律不成型', () => {
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
