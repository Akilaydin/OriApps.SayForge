
import { invoke } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { AsrHotwordCapability } from '../lib/asrModels'
import type { DiagnosticOccurrence, DiagnosticsPreview } from '../types/appApi'

// Re-export for convenience
export { invoke, listen, emit }

// ─── Window Controls ───

export function minimize() {
  getCurrentWindow().minimize()
}

export function maximize() {
  getCurrentWindow().toggleMaximize()
}

export function close() {
  getCurrentWindow().close()
}

// ─── Overlay ───

/**
 * Bug 003 diagnostic helper — log overlay IPC failures to runtime events
 * (which mirror to sayforge.log via appendDebugLog).
 */
function logOverlayIpcError(op: string, err: unknown) {
  try {
    // Lazy import to avoid circular dep with debugLog
    void import('./debugLog').then(({ addRuntimeEvent }) => {
      addRuntimeEvent('error', 'overlay-ipc', `${op} failed`, { error: String(err) })
    })
  } catch {
    console.error(`[overlay-ipc] ${op} failed:`, err)
  }
}

export interface OverlayHealthSnapshot {
  showId: number
  activeShowId: number
  activeGeneration: number
  acked: boolean
  ackGeneration: number
  ackLatencyMs: number
  recoveryStarted: boolean
  recoverySucceeded: boolean
  window: {
    handleExists: boolean
    visible?: boolean | null
    intersectsPrimary?: boolean
    position?: { x: number; y: number } | null
    size?: { width: number; height: number } | null
  }
}

export function presentOverlay(data: unknown) {
  return invoke<number>('present_overlay', { data }).catch((err) => {
    logOverlayIpcError('present_overlay', err)
    return 0
  })
}

export function showOverlay() {
  return invoke<number>('show_overlay').catch((err) => {
    logOverlayIpcError('show_overlay', err)
    return 0
  })
}

export function hideOverlay() {
  return invoke<void>('hide_overlay').catch((err) => {
    logOverlayIpcError('hide_overlay', err)
  })
}

export function updateOverlay(data: unknown) {
  return invoke<void>('update_overlay_state', { data }).catch((err) => {
    logOverlayIpcError('update_overlay_state', err)
  })
}

export function overlayReady(devicePixelRatio?: number) {
  return invoke<void>('overlay_ready', { devicePixelRatio })
}

export function overlayRenderAck(data: unknown) {
  return invoke<void>('overlay_render_ack', { data })
}

export function getOverlayHealth(showId: number) {
  return invoke<OverlayHealthSnapshot>('get_overlay_health', { showId })
}

export type EscapeActionMode =
  | 'off'
  | 'cancel_recording'
  | 'cancel_processing'
  | 'dismiss_fallback'
  | 'abandon_late_result'

export function setEscapeActionMode(mode: EscapeActionMode, token = 0) {
  return invoke<void>('set_escape_action_mode', { mode, token })
}

export type CardHotkeyAction = 'copy'

export function setCardHotkeys(actions: CardHotkeyAction[], token = 0) {
  return invoke<void>('set_card_hotkeys', { actions, token })
}

// ─── Paste / Context ───

export function pasteText(text: string, hwnd?: string, focusHwnd?: string, restoreClipboard?: boolean) {
  return invoke<{
    ok: boolean
    strategy?: string
    reason?: string
    detail?: string
    attempts?: Array<{ strategy: string; ok: boolean; reason?: string; detail?: string }>
  }>('paste_text', { text, hwnd: hwnd || null, focusHwnd: focusHwnd || null, restoreClipboard: restoreClipboard ?? false })
}

export function getProbeResult() {
  return invoke<Record<string, unknown>>('get_probe_result')
}

export function getRecordingContext(includeTextContext = false) {
  return invoke<{
    appContext: Record<string, unknown>
    probe: Record<string, unknown>
  }>('get_recording_context', { includeTextContext })
}

export function getActiveAppContext() {
  return invoke<Record<string, unknown> | null>('get_active_app_context')
}

export function getClientRuntimeInfo() {
  return invoke<{
    userId: string
    userName: string
    deviceId: string
    hostname: string
    clientVersion: string
    platform: string
    osVersion: string
    localIp: string
    systemLocale: string
    cpuCores: number
    memoryMb: number
  }>('get_client_runtime_info')
}

export function getSystemUiLanguage() {
  return invoke<string>('get_system_ui_language')
}

export function copyText(text: string) {
  return invoke('copy_text', { text })
}


export function muteSystemOutput() {
  return invoke<boolean>('mute_system_output')
}

export function restoreSystemOutput() {
  return invoke<boolean>('restore_system_output')
}

export function appendDebugLog(payload: unknown) {
  invoke('append_debug_log', { payload })
}

// ─── Store ───

export function storeGet(key: string) {
  return invoke<unknown>('store_get', { key })
}

export function storeSet(key: string, value: unknown) {
  return invoke('store_set', { key, value })
}

export function storeDelete(key: string) {
  return invoke('store_delete', { key })
}

// ─── History ───

export function historyList(query?: {
  keyword?: string
  favoriteOnly?: boolean
  limit?: number
  offset?: number
}) {
  return invoke<unknown[]>('history_list', { query })
}

export function historyCount(query?: {
  keyword?: string
  favoriteOnly?: boolean
}) {
  return invoke<number>('history_count', { query })
}

export function historyAdd(record: unknown) {
  return invoke('history_add', { record })
}

export function historyUpdate(id: string, patch: Record<string, unknown>) {
  return invoke('history_update', { id, patch })
}

export function historyDelete(id: string) {
  return invoke('history_delete', { id })
}

// ─── Export ───

export function saveTextExport(payload: {
  defaultPath: string
  content: string
  filters?: Array<{ name: string; extensions: string[] }>
}) {
  return invoke<string | null>('save_text_export', { payload })
}

// ─── Shortcuts ───

export const SHORTCUTS_CHANGED_EVENT = 'sayforge:shortcuts-changed'

export function notifyShortcutsChanged() {
  invoke('shortcuts_changed')
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT))
  }
}

export function testShortcut(accelerator: string) {
  return invoke<boolean>('test_shortcut', { accelerator })
}

export function getPTTPhysicalKeyStates(codes: string[]) {
  return invoke<boolean[]>('get_ptt_physical_key_states', { codes })
}

export function beginShortcutCapture() {
  return invoke('begin_shortcut_capture').catch(() => { })
}

export function endShortcutCapture() {
  return invoke('end_shortcut_capture').catch(() => { })
}

// ─── System ───

export function getAutoLaunch() {
  return invoke<boolean>('get_auto_launch')
}

export function setAutoLaunch(enable: boolean) {
  return invoke('set_auto_launch', { enable })
}

// ─── Tray ───

export function setTrayAiEnabled(enabled: boolean) {
  return invoke<void>('set_tray_ai_enabled', { enabled }).catch(() => { })
}

export function onAiCleanupChanged(cb: (enabled: boolean) => void) {
  const unlisten = listen<{ enabled?: boolean }>('ai-cleanup-changed', (event) => {
    cb(Boolean(event.payload?.enabled))
  })
  return () => { unlisten.then((fn) => fn()) }
}

export function onAiCleanupToggleRequested(cb: () => void) {
  const unlisten = listen('toggle-ai-cleanup', () => cb())
  return () => { unlisten.then((fn) => fn()) }
}

// ─── Diagnostics ───

export function collectSettings() {
  return invoke<Record<string, unknown>>('collect_settings')
}

export function getDiagnosticsPreview(data: {
  settings: Record<string, unknown>
  issueOccurrence: DiagnosticOccurrence
}) {
  return invoke<DiagnosticsPreview>('get_diagnostics_preview', { data })
}

export function createDiagnosticsZip(data: unknown) {
  return invoke<string>('create_diagnostics_zip', { data })
}

export function readDiagnosticsZip(path: string) {
  return invoke<number[] | null>('read_diagnostics_zip', { path })
}

export function copyDiagnosticsZip(source: string, destination: string) {
  return invoke<void>('copy_diagnostics_zip', { source, destination })
}

export function readLogFile(logType: string) {
  return invoke<string | null>('read_log_file', { logType })
}

export function openLogFolder() {
  return invoke('open_log_folder')
}

// ─── Event Listeners ───

export function onOverlayState(cb: (data: unknown) => void) {
  const unlisten = listen<unknown>('overlay-state', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onActiveAppContext(cb: (data: unknown) => void) {
  const unlisten = listen<unknown>('active-app-context', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTDown(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-down', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTUp(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-up', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTToggle(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-toggle', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTTimeoutWarning(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-timeout-warning', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onToggleHandsFree(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('toggle-hands-free', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onEscapeAction(cb: (data: { mode: EscapeActionMode; token: number }) => void) {
  const unlisten = listen<{ mode: EscapeActionMode; token: number }>('escape-action', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onCardHotkey(cb: (data: { action: CardHotkeyAction; token: number }) => void) {
  const unlisten = listen<{ action: CardHotkeyAction; token: number }>('card-hotkey', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export const OVERLAY_CARD_DISMISSED = 'overlay-card-dismissed'

export function notifyCardDismissed(reason: string, token: number) {
  return emit(OVERLAY_CARD_DISMISSED, { reason, token })
}

export function onCardDismissed(cb: (data: { reason: string; token: number }) => void) {
  const unlisten = listen<{ reason: string; token: number }>(OVERLAY_CARD_DISMISSED, (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onMouseShortcutCaptured(cb: (data: { setting: string; vk: number }) => void) {
  const unlisten = listen<{ setting: string; vk: number }>('mouse-shortcut-captured', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function asrHotwordCapability(provider: string, extra?: Record<string, unknown>) {
  return invoke<AsrHotwordCapability>('asr_hotword_capability', { provider, extra })
    .catch(() => null)
}

export function asrHotwordCapabilityMatrix() {
  return invoke<Record<string, AsrHotwordCapability>>('asr_hotword_capability_matrix')
    .catch(() => null)
}

export const ASR_CAPABILITY_MAYBE_CHANGED_EVENT = 'sayforge:asr-capability-maybe-changed'

export function notifyAsrCapabilityMaybeChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ASR_CAPABILITY_MAYBE_CHANGED_EVENT))
  }
}
