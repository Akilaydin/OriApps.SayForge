import { RecorderOrchestrator } from './recorder/RecorderOrchestrator'
import type { RecorderState } from './recorder/types'

let orchestrator = new RecorderOrchestrator()

// HMR cleanup: dispose old orchestrator when module is hot-replaced
if ((import.meta as unknown as Record<string, unknown>).hot) {
  const hot = (import.meta as unknown as Record<string, unknown>).hot as { dispose: (cb: () => void) => void }
  hot.dispose(() => {
    console.log('[recorder] HMR dispose: cleaning up old orchestrator')
    orchestrator.cleanup()
  })
}

export function setStateListener(cb: (s: RecorderState) => void) {
  orchestrator.setStateListener(cb)
}

export function getState() {
  return orchestrator.getState()
}

export function beginUpdateInstallation(): boolean {
  return orchestrator.beginUpdateInstallation()
}

export function endUpdateInstallation() {
  orchestrator.endUpdateInstallation()
}

export async function initRecorder() {
  await orchestrator.init()
}

export function cleanup() {
  orchestrator.cleanup()
}

/** Call after changing settings that recorder caches (preset, mic, overlay display) */
export async function refreshRecorderSettings() {
  await orchestrator.refreshRuntimeSettings()
}

export function setAiEnabledCache(next: boolean) {
  orchestrator.setAiEnabledCache(next)
}

export function showAiEnabledToast(enabled: boolean) {
  orchestrator.showAiEnabledToast(enabled)
}

export function setHotwordsCache(words: string[]) {
  orchestrator.setHotwordsCache(words)
}

export async function refreshOverlaySettings() {
  await orchestrator.refreshOverlaySettings()
}

export function reconnectProvider() {
  orchestrator.reconnectProvider()
}

/** Backward-compatible alias */
export async function refreshPreset() {
  await orchestrator.refreshRuntimeSettings()
}

export function setPttSuppressed(suppressed: boolean) {
  orchestrator.setPttSuppressed(suppressed)
}

