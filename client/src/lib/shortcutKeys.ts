
import { t, type TranslationKey } from '@/i18n'

export interface SingleKeyDef {
  setting: string
  vk: number
  label: string
}

export const SINGLE_KEYS: SingleKeyDef[] = [
  { setting: 'AltLeft', vk: 0xa4, label: 'Left Alt' },
  { setting: 'AltRight', vk: 0xa5, label: 'Right Alt' },
  { setting: 'ControlLeft', vk: 0xa2, label: 'Left Ctrl' },
  { setting: 'ControlRight', vk: 0xa3, label: 'Right Ctrl' },
  { setting: 'ShiftLeft', vk: 0xa0, label: 'Left Shift' },
  { setting: 'ShiftRight', vk: 0xa1, label: 'Right Shift' },
  { setting: 'CapsLock', vk: 0x14, label: 'Caps Lock' },
  { setting: 'Space', vk: 0x20, label: 'Space' },
  { setting: 'ContextMenu', vk: 0x5d, label: 'Menu key' },
  { setting: 'Pause', vk: 0x13, label: 'Pause' },
  { setting: 'ScrollLock', vk: 0x91, label: 'ScrollLock' },
  { setting: 'Insert', vk: 0x2d, label: 'Insert' },
  { setting: 'XButton1', vk: 0x05, label: 'Mouse back' },
  { setting: 'XButton2', vk: 0x06, label: 'Mouse forward' },
  { setting: 'MButton', vk: 0x04, label: 'Middle mouse button' },
  { setting: 'BrowserBack', vk: 0xa6, label: 'Browser back' },
  { setting: 'BrowserForward', vk: 0xa7, label: 'Browser forward' },
  //
  ...Array.from({ length: 24 }, (_, index) => ({
    setting: `F${index + 1}`,
    vk: 0x70 + index,
    label: `F${index + 1}`,
  })),
]

export const SETTING_TO_VK: Record<string, number> = Object.fromEntries(
  SINGLE_KEYS.map((key) => [key.setting, key.vk]),
)

const SINGLE_KEY_DISPLAY: Record<string, string> = Object.fromEntries(
  SINGLE_KEYS.map((key) => [key.setting, key.label]),
)

export const PTT_MODIFIER_CODES = [
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
] as const

const PTT_MODIFIER_SET = new Set<string>(PTT_MODIFIER_CODES)
const PTT_MOUSE_CODES = new Set(['XButton1', 'XButton2', 'MButton'])

const PTT_FORBIDDEN_CODES = new Set(['ShiftLeft', 'ShiftRight'])

export function isPTTForbiddenCode(code: string): boolean {
  return PTT_FORBIDDEN_CODES.has(code)
}

const PTT_EXTRA_KEY_DEFS: SingleKeyDef[] = [
  { setting: 'MetaLeft', vk: 0x5b, label: 'Left Win' },
  { setting: 'MetaRight', vk: 0x5c, label: 'Right Win' },
  ...Array.from({ length: 26 }, (_, index) => ({
    setting: `Key${String.fromCharCode(65 + index)}`,
    vk: 0x41 + index,
    label: String.fromCharCode(65 + index),
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    setting: `Digit${index}`,
    vk: 0x30 + index,
    label: String(index),
  })),
  { setting: 'Escape', vk: 0x1b, label: 'Esc' },
  { setting: 'Tab', vk: 0x09, label: 'Tab' },
  { setting: 'Enter', vk: 0x0d, label: 'Enter' },
  { setting: 'Backspace', vk: 0x08, label: 'Backspace' },
  { setting: 'Delete', vk: 0x2e, label: 'Delete' },
  { setting: 'ArrowUp', vk: 0x26, label: '↑' },
  { setting: 'ArrowDown', vk: 0x28, label: '↓' },
  { setting: 'ArrowLeft', vk: 0x25, label: '←' },
  { setting: 'ArrowRight', vk: 0x27, label: '→' },
  { setting: 'Home', vk: 0x24, label: 'Home' },
  { setting: 'End', vk: 0x23, label: 'End' },
  { setting: 'PageUp', vk: 0x21, label: 'Page Up' },
  { setting: 'PageDown', vk: 0x22, label: 'Page Down' },
]

export const PTT_CODE_TO_VK: Record<string, number> = {
  ...SETTING_TO_VK,
  ...Object.fromEntries(PTT_EXTRA_KEY_DEFS.map((key) => [key.setting, key.vk])),
}

const PTT_CODE_DISPLAY: Record<string, string> = {
  ...SINGLE_KEY_DISPLAY,
  ...Object.fromEntries(PTT_EXTRA_KEY_DEFS.map((key) => [key.setting, key.label])),
}

export function isSingleKeySetting(setting: string): boolean {
  return setting in SETTING_TO_VK
}

export function resolveSingleKeyShortcut(code: string): string | undefined {
  return isSingleKeySetting(code) ? code : undefined
}

export function settingToCode(setting: string): string {
  return isSingleKeySetting(setting) ? setting : ''
}

const TRANSLATED_KEY_NAMES: Record<string, TranslationKey> = {
  AltLeft: 'keyName.AltLeft',
  AltRight: 'keyName.AltRight',
  ControlLeft: 'keyName.ControlLeft',
  ControlRight: 'keyName.ControlRight',
  ShiftLeft: 'keyName.ShiftLeft',
  ShiftRight: 'keyName.ShiftRight',
  MetaLeft: 'keyName.MetaLeft',
  MetaRight: 'keyName.MetaRight',
  Space: 'keyName.Space',
  ContextMenu: 'keyName.ContextMenu',
  XButton1: 'keyName.XButton1',
  XButton2: 'keyName.XButton2',
  MButton: 'keyName.MButton',
  BrowserBack: 'keyName.BrowserBack',
  BrowserForward: 'keyName.BrowserForward',
}

export function getSingleKeyDisplay(value: string): string {
  const key = TRANSLATED_KEY_NAMES[value]
  if (key) return t(key)
  return SINGLE_KEY_DISPLAY[value] || value
}

export function displayAccelerator(accelerator: string): string[] {
  const displayNames: Record<string, string> = {
    CommandOrControl: 'Ctrl',
    Control: 'Ctrl',
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Space: 'Space',
    Return: 'Enter',
  }
  return accelerator.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => displayNames[part] || part)
}

export function displayShortcut(shortcut: string): string[] {
  return isSingleKeySetting(shortcut)
    ? [getSingleKeyDisplay(shortcut)]
    : displayAccelerator(shortcut)
}

export function eventToAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const key = event.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null

  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
  }

  const mapped = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key)
  parts.push(mapped)
  return parts.length >= 2 ? parts.join('+') : null
}

export function keyEventToShortcutCandidate(
  event: KeyboardEvent,
  options: { comboOnly?: boolean } = {},
): string | null {
  const accelerator = eventToAccelerator(event)
  if (accelerator) return accelerator
  if (options.comboOnly) return null
  return resolveSingleKeyShortcut(event.code) ?? null
}

export function parsePTTShortcut(setting: string): string[] {
  if (!setting.trim()) return []
  return setting.split('+').map((part) => part.trim()).filter(Boolean)
}

export function canonicalizePTTShortcut(settingOrCodes: string | Iterable<string>): string {
  const codes = typeof settingOrCodes === 'string'
    ? parsePTTShortcut(settingOrCodes)
    : Array.from(settingOrCodes)
  const uniqueCodes = [...new Set(codes)]
  const modifierOrder = new Map<string, number>(
    PTT_MODIFIER_CODES.map((code, index) => [code, index]),
  )
  return uniqueCodes.sort((left, right) => {
    const leftOrder = modifierOrder.get(left) ?? PTT_MODIFIER_CODES.length
    const rightOrder = modifierOrder.get(right) ?? PTT_MODIFIER_CODES.length
    return leftOrder - rightOrder || left.localeCompare(right)
  }).join('+')
}

export function displayPTTShortcut(setting: string): string[] {
  return parsePTTShortcut(canonicalizePTTShortcut(setting)).map((code) => {
    const key = TRANSLATED_KEY_NAMES[code]
    return key ? t(key) : PTT_CODE_DISPLAY[code] || code
  })
}

export function isPTTModifierCode(code: string): boolean {
  return PTT_MODIFIER_SET.has(code)
}

export function pttShortcutHasModifier(setting: string): boolean {
  return parsePTTShortcut(setting).some(isPTTModifierCode)
}

export function getPTTShortcutWarning(setting: string): string | null {
  return parsePTTShortcut(canonicalizePTTShortcut(setting)).some(isPTTForbiddenCode)
    ? t('shortcut.warning.shiftNoLongerSupported')
    : null
}

function normalizedAcceleratorParts(accelerator: string): string[] {
  const aliases: Record<string, string> = {
    Ctrl: 'Control',
    CommandOrControl: 'Control',
    Super: 'Meta',
    Win: 'Meta',
    Windows: 'Meta',
    Return: 'Enter',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
  }
  return accelerator.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => aliases[part] || part)
}

export function getAcceleratorShortcutValidationError(accelerator: string): string | null {
  const parts = normalizedAcceleratorParts(accelerator)
  const has = (key: string) => parts.includes(key)
  const mainKeys = parts.filter((part) => !['Control', 'Meta', 'Alt', 'Shift'].includes(part))
  const mainKey = mainKeys[0]

  if (has('Control') && has('Alt') && mainKey === 'Delete') {
    return t('shortcut.error.reservedCtrlAltDel')
  }
  if (has('Meta') && mainKey) {
    return t('shortcut.error.reservedWindows')
  }
  if (has('Alt') && ['F4', 'Tab', 'Escape', 'Space'].includes(mainKey)) {
    return t('shortcut.error.reservedAlt')
  }
  if (has('Control') && mainKey === 'Escape') {
    return t('shortcut.error.reservedCtrlEsc')
  }
  return null
}

export interface PTTValidationOptions {
  allowLegacyReservedKeys?: boolean
}

export function getPTTShortcutValidationError(
  setting: string,
  options: PTTValidationOptions = {},
): string | null {
  const rawCodes = setting.split('+').map((part) => part.trim())
  const codes = rawCodes.filter(Boolean)
  if (codes.length === 0) return t('shortcut.error.empty')
  if (rawCodes.length !== codes.length || new Set(codes).size !== codes.length) {
    return t('shortcut.error.invalidFormat')
  }

  const unsupported = codes.find((code) => !(code in PTT_CODE_TO_VK))
  if (unsupported) return t('shortcut.error.unsupportedKey', { key: unsupported })

  if (!options.allowLegacyReservedKeys && codes.some(isPTTForbiddenCode)) {
    return t('shortcut.error.shiftReserved')
  }

  if (codes.length === 1) {
    const code = codes[0]
    if (code === 'MetaLeft' || code === 'MetaRight') {
      return t('shortcut.error.metaAlone')
    }
    if (!isSingleKeySetting(code)) {
      return t('shortcut.error.plainKeyAlone')
    }
    return null
  }

  if (codes.some((code) => PTT_MOUSE_CODES.has(code))) {
    return t('shortcut.error.mouseCombo')
  }

  const modifiers = codes.filter(isPTTModifierCode)
  const mainKeys = codes.filter((code) => !isPTTModifierCode(code))
  const modifierFamilies = modifiers.map((code) => code.replace(/(?:Left|Right)$/, ''))
  if (new Set(modifierFamilies).size !== modifierFamilies.length) {
    return t('shortcut.error.sameModifierFamily')
  }
  if (mainKeys.length > 1) return t('shortcut.error.tooManyMainKeys')
  if (mainKeys.length === 1 && modifiers.length === 0) {
    return t('shortcut.error.needModifier')
  }
  if (mainKeys.length === 0 && modifiers.length < 2) {
    return t('shortcut.error.needTwoModifiers')
  }

  const hasFamily = (prefix: string) => modifiers.some((code) => code.startsWith(prefix))
  const mainKey = mainKeys[0]
  if (hasFamily('Control') && hasFamily('Alt') && mainKey === 'Delete') {
    return t('shortcut.error.reservedCtrlAltDel')
  }
  if (hasFamily('Meta') && mainKey) {
    return t('shortcut.error.reservedWindows')
  }
  if (hasFamily('Alt') && ['F4', 'Tab', 'Escape', 'Space'].includes(mainKey)) {
    return t('shortcut.error.reservedAlt')
  }
  if (hasFamily('Control') && mainKey === 'Escape') {
    return t('shortcut.error.reservedCtrlEsc')
  }

  return null
}

export function isValidPTTShortcut(
  setting: string,
  options: PTTValidationOptions = {},
): boolean {
  return getPTTShortcutValidationError(setting, options) === null
}

function pttMainCodeToAccelerator(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const aliases: Record<string, string> = {
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return aliases[code] || code
}

export function pttShortcutToAccelerator(setting: string): string | undefined {
  if (!isValidPTTShortcut(setting)) return undefined
  const codes = parsePTTShortcut(canonicalizePTTShortcut(setting))
  const mainKeys = codes.filter((code) => !isPTTModifierCode(code))
  if (mainKeys.length !== 1) return undefined

  const hasControl = codes.some((code) => code.startsWith('Control'))
  const hasMeta = codes.some((code) => code.startsWith('Meta'))
  if (hasControl && hasMeta) return undefined

  const parts: string[] = []
  if (hasControl || hasMeta) parts.push('CommandOrControl')
  if (codes.some((code) => code.startsWith('Alt'))) parts.push('Alt')
  if (codes.some((code) => code.startsWith('Shift'))) parts.push('Shift')
  parts.push(pttMainCodeToAccelerator(mainKeys[0]))
  return parts.join('+')
}

function normalizeAccelerator(accelerator: string): string {
  const order: Record<string, number> = { CommandOrControl: 0, Alt: 1, Shift: 2 }
  const aliases: Record<string, string> = {
    Ctrl: 'CommandOrControl',
    Control: 'CommandOrControl',
    Command: 'CommandOrControl',
    Meta: 'CommandOrControl',
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return accelerator.split('+')
    .map((part) => aliases[part] || part)
    .sort((left, right) => (order[left] ?? 3) - (order[right] ?? 3) || left.localeCompare(right))
    .join('+')
}

export function pttShortcutConflictsWithAccelerator(
  pttSetting: string,
  otherShortcut: string,
): boolean {
  if (!pttSetting || !otherShortcut) return false
  const pttCodes = parsePTTShortcut(canonicalizePTTShortcut(pttSetting))
  if (isSingleKeySetting(otherShortcut) && pttCodes.includes(otherShortcut)) return true
  if (canonicalizePTTShortcut(pttSetting) === canonicalizePTTShortcut(otherShortcut)) return true
  const accelerator = pttShortcutToAccelerator(pttSetting)
  return accelerator !== undefined
    && normalizeAccelerator(accelerator) === normalizeAccelerator(otherShortcut)
}
