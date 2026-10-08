//
//

type Listener = () => void

let dirty = false
const listeners = new Set<Listener>()

export function getEngineDraftDirty(): boolean {
  return dirty
}

export function subscribeEngineDraft(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setEngineDraftDirty(next: boolean): void {
  if (dirty === next) return
  dirty = next
  for (const listener of listeners) listener()
}
