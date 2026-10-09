import { isTauri } from '@tauri-apps/api/core'
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { beginUpdateInstallation, endUpdateInstallation } from './recorder'

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'up-to-date'
  | 'downloading' | 'waiting' | 'installing' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  version?: string
  notes?: string
  percent?: number
  errorStage?: 'check' | 'install'
}

const subscribers = new Set<() => void>()
let status: UpdateStatus = { phase: 'idle' }
let pendingUpdate: Update | null = null
let dismissedVersion: string | null = null
let checkInFlight: Promise<void> | null = null
let installInFlight: Promise<void> | null = null
let manualCheckRequested = false
let cancelWaiting = false

function discardPendingUpdate() {
  const previous = pendingUpdate
  pendingUpdate = null
  if (previous) void previous.close().catch(() => { })
}

function publish(next: UpdateStatus) {
  status = next
  subscribers.forEach((listener) => listener())
}

export function subscribeUpdates(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/** Quiet on startup; an explicit About check always reports success or failure. */
export function checkForUpdates(manual = false): Promise<void> {
  if (!isTauri() || installInFlight) return Promise.resolve()
  if (manual) manualCheckRequested = true
  if (checkInFlight) return checkInFlight

  publish({ phase: 'checking' })
  const operation = async () => {
    try {
      const update = await check({ timeout: 15000 })
      discardPendingUpdate()
      pendingUpdate = update
      if (!update) {
        publish({ phase: manualCheckRequested ? 'up-to-date' : 'idle' })
      } else if (update.version === dismissedVersion && !manualCheckRequested) {
        discardPendingUpdate()
        publish({ phase: 'idle' })
      } else {
        publish({ phase: 'available', version: update.version, notes: update.body?.slice(0, 600) })
      }
    } catch {
      discardPendingUpdate()
      // An automatic network failure must never interrupt dictation or display an error.
      publish({ phase: manualCheckRequested ? 'error' : 'idle', errorStage: 'check' })
    } finally {
      manualCheckRequested = false
      checkInFlight = null
    }
  }
  checkInFlight = operation()
  return checkInFlight
}

export function postponeUpdate() {
  if (status.phase !== 'available') return
  dismissedVersion = status.version ?? null
  discardPendingUpdate()
  publish({ phase: 'idle' })
}

export function cancelPendingInstallation() {
  if (status.phase === 'waiting') cancelWaiting = true
}

export function installAvailableUpdate(): Promise<void> {
  if (installInFlight || status.phase !== 'available' || !pendingUpdate) return Promise.resolve()
  const update = pendingUpdate
  cancelWaiting = false

  const operation = async () => {
    let reserved = false
    try {
      let downloaded = 0
      let total: number | undefined
      publish({ phase: 'downloading', version: update.version, percent: 0 })
      await update.download((event: DownloadEvent) => {
        if (event.event === 'Started') total = event.data.contentLength ?? undefined
        if (event.event === 'Progress') downloaded += event.data.chunkLength
        publish({
          phase: 'downloading', version: update.version,
          percent: total ? Math.min(100, Math.floor(downloaded / total * 100)) : undefined,
        })
      })

      publish({ phase: 'waiting', version: update.version })
      while (!cancelWaiting && !(reserved = beginUpdateInstallation())) {
        await new Promise<void>((resolve) => setTimeout(resolve, 400))
      }
      if (cancelWaiting) {
        discardPendingUpdate()
        publish({ phase: 'idle' })
        return
      }

      publish({ phase: 'installing', version: update.version })
      // On Windows this launches the signed NSIS installer and exits the app.
      await update.install()
    } catch {
      discardPendingUpdate()
      publish({ phase: 'error', version: update.version, errorStage: 'install' })
    } finally {
      if (reserved) endUpdateInstallation()
      installInFlight = null
    }
  }
  installInFlight = operation()
  return installInFlight
}
