
import { emit } from '@tauri-apps/api/event'
import { getPTTPhysicalKeyStates } from './bridge'
import { getSetting } from './store'
import { getDefault } from './defaults'
import {
  canonicalizePTTShortcut,
  isPTTModifierCode,
  isValidPTTShortcut,
  parsePTTShortcut,
  PTT_CODE_TO_VK,
  SETTING_TO_VK,
  settingToCode,
} from '@/lib/shortcutKeys'

const PTT_LAB_CODE = 'ControlRight'
const PTT_LAB_VK = 0xa3

let pttCodes: string[] = []
let pttSetting = ''
let pttKeyDown = false
const pttPressed = new Set<string>()
const pttConsumedCodes = new Set<string>()
let pttStartCheckToken = 0
let pttStartCheckPending = false
let hfCode = ''
let hfSetting = ''
let hfKeyDown = false
let labKeyDown = false
let labEnabled = false
let started = false
let captureActive = false

function isModifierSetting(setting: string) {
  return ['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(setting)
}

function pttModifierFlags() {
  return {
    altKey: pttCodes.some((code) => code.startsWith('Alt')),
    ctrlKey: pttCodes.some((code) => code.startsWith('Control')),
    shiftKey: pttCodes.some((code) => code.startsWith('Shift')),
    metaKey: pttCodes.some((code) => code.startsWith('Meta')),
  }
}

function shouldConsumePTTDown(code: string, wasPressed: boolean) {
  if (pttCodes.length === 1) return true
  if (isPTTModifierCode(code)) return false
  if (wasPressed) return pttConsumedCodes.has(code)
  return pttCodes
    .filter(isPTTModifierCode)
    .every((modifier) => pttPressed.has(modifier))
}

function reconcileStalePTTModifiers(event: KeyboardEvent) {
  for (const code of [...pttPressed]) {
    if (code === event.code || !isPTTModifierCode(code)) continue
    const physicallyDown = code.startsWith('Control')
      ? event.ctrlKey
      : code.startsWith('Alt')
        ? event.altKey
        : code.startsWith('Shift')
          ? event.shiftKey
          : event.metaKey
    if (!physicallyDown) {
      pttPressed.delete(code)
      pttConsumedCodes.delete(code)
    }
  }
}

function invalidatePTTStartCheck() {
  pttStartCheckToken += 1
  pttStartCheckPending = false
}

async function confirmPhysicalPTTStart(triggerCode: string) {
  if (pttStartCheckPending) return
  pttStartCheckPending = true
  const token = ++pttStartCheckToken
  const codes = [...pttCodes]
  const setting = pttSetting

  try {
    const physicalStates = await getPTTPhysicalKeyStates(codes)
    if (token !== pttStartCheckToken) return

    codes.forEach((code, index) => {
      if (!physicalStates[index]) {
        pttPressed.delete(code)
        pttConsumedCodes.delete(code)
      }
    })

    const allStillDown = physicalStates.length === codes.length
      && physicalStates.every(Boolean)
      && codes.every((code) => pttPressed.has(code))
    if (!captureActive && !pttKeyDown && pttSetting === setting && allStillDown) {
      pttKeyDown = true
      emitPTT('down', triggerCode, 'physical_members_confirmed')
    }
  } catch (error) {
    console.warn('[webview-kb] failed to verify physical PTT state:', error)
  } finally {
    if (token === pttStartCheckToken) pttStartCheckPending = false
  }
}

function emitPTT(phase: 'down' | 'up', triggerCode: string, reason: string) {
  const vk = PTT_CODE_TO_VK[triggerCode] || 0
  console.log(`[webview-kb] ptt-${phase} (webview fallback)`, {
    code: triggerCode,
    pttSetting,
    reason,
  })
  void emit(`ptt-${phase}`, {
    source: 'webview_fallback',
    reason,
    vk,
    keycode: vk,
    pttSetting,
    timestamp: Date.now(),
    ...pttModifierFlags(),
  })
}

function releasePTT(reason: string, triggerCode = pttCodes[0] || '') {
  invalidatePTTStartCheck()
  if (pttKeyDown) {
    pttKeyDown = false
    emitPTT('up', triggerCode, reason)
  }
  pttPressed.clear()
  pttConsumedCodes.clear()
}

function handleKeyDown(event: KeyboardEvent) {
  if (captureActive) return

  if (pttCodes.includes(event.code)) {
    reconcileStalePTTModifiers(event)
    const wasPressed = pttPressed.has(event.code)
    const consumeDown = shouldConsumePTTDown(event.code, wasPressed)
    if (consumeDown) {
      if (pttCodes.length > 1) pttConsumedCodes.add(event.code)
      event.preventDefault()
    }
    pttPressed.add(event.code)
    if (!pttKeyDown && pttCodes.every((code) => pttPressed.has(code))) {
      if (pttCodes.length > 1 && isPTTModifierCode(event.code)) {
        void confirmPhysicalPTTStart(event.code)
      } else {
        invalidatePTTStartCheck()
        pttKeyDown = true
        emitPTT('down', event.code, 'all_members_down')
      }
    }
    return
  }

  if (hfCode && event.code === hfCode && !pttCodes.includes(hfCode)) {
    if (!hfKeyDown) {
      hfKeyDown = true
      console.log('[webview-kb] toggle-hands-free (webview fallback)', {
        code: event.code,
        hfSetting,
      })
      void emit('toggle-hands-free', {
        source: 'webview_fallback',
        vk: SETTING_TO_VK[hfSetting] || 0,
      })
    }
    if (isModifierSetting(hfSetting)) event.preventDefault()
    return
  }

  if (labEnabled && event.code === PTT_LAB_CODE && !labKeyDown) {
    if (pttCodes.includes(PTT_LAB_CODE)) return
    labKeyDown = true
    event.preventDefault()
    console.log('[webview-kb] ptt-lab-event down (webview fallback)')
    void emit('ptt-lab-event', {
      phase: 'down',
      vk: PTT_LAB_VK,
      timestamp: Date.now(),
    })
  }
}

function handleKeyUp(event: KeyboardEvent) {
  if (captureActive) return

  if (pttCodes.includes(event.code)) {
    invalidatePTTStartCheck()
    if (pttCodes.length === 1 || pttConsumedCodes.delete(event.code)) {
      event.preventDefault()
    }
    const wasPressed = pttPressed.delete(event.code)
    if (wasPressed && pttKeyDown) {
      pttKeyDown = false
      emitPTT('up', event.code, 'member_up')
    }
    return
  }

  if (hfCode && event.code === hfCode && hfKeyDown && !pttCodes.includes(hfCode)) {
    hfKeyDown = false
    if (isModifierSetting(hfSetting)) event.preventDefault()
    return
  }

  if (labEnabled && event.code === PTT_LAB_CODE && labKeyDown) {
    if (pttCodes.includes(PTT_LAB_CODE)) return
    labKeyDown = false
    event.preventDefault()
    console.log('[webview-kb] ptt-lab-event up (webview fallback)')
    void emit('ptt-lab-event', {
      phase: 'up',
      vk: PTT_LAB_VK,
      timestamp: Date.now(),
    })
  }
}

function handleWindowBlur() {
  releasePTT('window_blur')
  hfKeyDown = false
  labKeyDown = false
}

export async function refreshPTTSetting() {
  try {
    const setting = await getSetting<string>('shortcutPTT')
    const loadedSetting = String(setting ?? '')
    if (!loadedSetting) {
      pttSetting = ''
      pttCodes = []
    } else {
      const canonical = canonicalizePTTShortcut(loadedSetting)
      pttSetting = isValidPTTShortcut(canonical, { allowLegacyReservedKeys: true })
        ? canonical
        : getDefault<string>('shortcutPTT', '')
      pttCodes = parsePTTShortcut(pttSetting)
      if (pttSetting !== canonical) {
        console.warn('[webview-kb] invalid PTT setting, falling back to the default:', loadedSetting)
      }
    }
  } catch (error) {
    pttSetting = getDefault<string>('shortcutPTT', '')
    pttCodes = parsePTTShortcut(pttSetting)
    console.warn('[webview-kb] failed to load PTT setting, using fallback:', error)
  }
  releasePTT('setting_refreshed')

  try {
    const hfSettingVal = await getSetting('shortcutHandsFree', 'AltRight')
    hfSetting = String(hfSettingVal ?? 'AltRight')
  } catch {
    hfSetting = 'AltRight'
  }
  hfCode = settingToCode(hfSetting)
  hfKeyDown = false

  console.log('[webview-kb] PTT setting refreshed:', pttSetting, '→ codes:', pttCodes)
  console.log('[webview-kb] HF setting refreshed:', hfSetting, '→ code:', hfCode)
}

export function setShortcutCaptureActive(active: boolean) {
  if (active) releasePTT('shortcut_capture')
  captureActive = active
  pttPressed.clear()
  hfKeyDown = false
  labKeyDown = false
}

export function setLabEnabled(enabled: boolean) {
  labEnabled = enabled
  if (!enabled) labKeyDown = false
}

export async function startWebviewKeyboardFallback() {
  if (started) return
  started = true

  await refreshPTTSetting()

  document.addEventListener('keydown', handleKeyDown, { capture: true })
  document.addEventListener('keyup', handleKeyUp, { capture: true })
  window.addEventListener('blur', handleWindowBlur)
  console.log('[webview-kb] started, pttSetting:', pttSetting, 'codes:', pttCodes)
}

export function stopWebviewKeyboardFallback() {
  if (!started) return
  started = false
  releasePTT('fallback_stopped')
  hfKeyDown = false
  labKeyDown = false
  document.removeEventListener('keydown', handleKeyDown, { capture: true })
  document.removeEventListener('keyup', handleKeyUp, { capture: true })
  window.removeEventListener('blur', handleWindowBlur)
  console.log('[webview-kb] stopped')
}
