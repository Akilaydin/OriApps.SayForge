//

import { getActivePresetId, getPromptPresets } from '@/services/store'

type Listener = () => void

export interface ActivePresetState {
  id: string
  name: string
}

let current: ActivePresetState = { id: 'intent', name: '' }
let initialized = false
const listeners = new Set<Listener>()

function emitChange() {
  for (const listener of listeners) listener()
}

async function resolve(id: string): Promise<ActivePresetState> {
  try {
    const presets = await getPromptPresets()
    const found = presets.find((p) => p.id === id)
    return { id, name: found?.name || '' }
  } catch {
    return { id, name: '' }
  }
}

export async function initActivePreset(): Promise<void> {
  if (initialized) return
  initialized = true
  const id = await getActivePresetId()
  current = await resolve(id)
  emitChange()
}

export function getActivePresetSnapshot(): ActivePresetState {
  return current
}

export function subscribeActivePreset(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setActivePresetKnown(id: string, name: string): void {
  if (id !== current.id || name !== current.name) {
    current = { id, name }
    emitChange()
  }
}

export async function refreshActivePreset(): Promise<void> {
  const id = await getActivePresetId()
  const next = await resolve(id)
  if (next.id !== current.id || next.name !== current.name) {
    current = next
    emitChange()
  }
}
