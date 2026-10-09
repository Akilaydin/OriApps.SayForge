
import { getSetting, setSetting } from '@/services/store'
import { setAiEnabledCache, showAiEnabledToast } from '@/services/recorder'
import * as bridge from '@/services/bridge'

type Listener = () => void

let currentValue = false
let initialized = false
let ready = false
const listeners = new Set<Listener>()

function emitChange() {
  for (const listener of listeners) listener()
}

export async function initAiEnabled(): Promise<void> {
  if (initialized) return
  initialized = true
  const stored = await getSetting('aiEnabled', false)
  const next = Boolean(stored)
  if (next !== currentValue) {
    currentValue = next
    emitChange()
  }
  void bridge.setTrayAiEnabled(next)

  //
  bridge.onAiCleanupChanged((enabled) => {
    applyExternalAiEnabled(enabled)
  })
  bridge.onAiCleanupToggleRequested(() => {
    void setAiEnabled(!currentValue, { showToast: true })
  })
  const flipReady = () => { ready = true; emitChange() }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flipReady)
  else flipReady()
}

export function getAiEnabled(): boolean {
  return currentValue
}

export function getAiEnabledReady(): boolean {
  return ready
}

export function subscribeAiEnabled(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function setAiEnabled(next: boolean, options: { showToast?: boolean } = {}): Promise<void> {
  if (next !== currentValue) {
    currentValue = next
    emitChange()
  }
  setAiEnabledCache(next)
  void setSetting('aiEnabled', next)
  void bridge.setTrayAiEnabled(next)
  if (options.showToast) showAiEnabledToast(next)
}

export async function toggleAiEnabled(): Promise<void> {
  await setAiEnabled(!currentValue)
}

function applyExternalAiEnabled(next: boolean): void {
  if (next !== currentValue) {
    currentValue = next
    emitChange()
  }
  setAiEnabledCache(next)
}
