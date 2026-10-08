
import { listen } from '@tauri-apps/api/event'
import { checkVersionUpdate, compareVersions, type VersionInfo } from './updateChecker'
import { getSetting, setSetting } from '@/services/store'
import * as bridge from '@/services/bridge'
import { addRuntimeEvent } from '@/services/debugLog'
import { getOfficialUpdateBaseUrl, getUpdateBaseUrl, isOfficialUpdateChannel } from '@/services/runtimeConfig'
import { getState as getRecorderState } from '@/services/recorder'
import { t } from '@/i18n'

export interface PendingUpdate {
  version: string
  filePath: string
  sha512?: string | null
}

const PENDING_UPDATE_KEY = 'pendingUpdate'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function readCurrentVersion(): string | null {
  const value = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null
  return value && /^\d+(\.\d+)*$/.test(value) ? value : null
}

export type AutoUpdatePhase = 'idle' | 'checking' | 'downloading' | 'installing'

export interface AutoUpdateState {
  phase: AutoUpdatePhase
  versionInfo?: VersionInfo | null
  checkedAt?: number | null
  pending?: PendingUpdate | null
  error?: string | null
  installError?: string | null
  downloadPercent?: number
}

let currentState: AutoUpdateState = { phase: 'idle', versionInfo: null, checkedAt: null, pending: null }
const listeners: Set<(state: AutoUpdateState) => void> = new Set()
let inFlight: Promise<void> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null

void listen<{ downloadedBytes: number; totalBytes: number; percent: number; status: string; error: string | null }>(
  'update-download-progress',
  (event) => {
    const { percent } = event.payload
    setState({ downloadPercent: percent })
  },
)

function setState(patch: Partial<AutoUpdateState>) {
  currentState = { ...currentState, ...patch }
  listeners.forEach((cb) => cb(currentState))
}

export function getAutoUpdateState() {
  return currentState
}

export function onAutoUpdateChange(cb: (state: AutoUpdateState) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function hasPendingUpdate(state: AutoUpdateState = currentState): boolean {
  return !!state.pending
}

async function savePending(pending: PendingUpdate): Promise<void> {
  await setSetting(PENDING_UPDATE_KEY, pending)
  setState({ pending, downloadPercent: 100, installError: null })
}

async function clearPending(): Promise<void> {
  await setSetting(PENDING_UPDATE_KEY, null).catch(() => { })
  setState({ pending: null, installError: null })
}

export async function discardPendingForChannelSwitch(): Promise<void> {
  await clearPending()
  setState({ versionInfo: null, checkedAt: null, downloadPercent: 0, error: null })
}

async function restorePending(current: string): Promise<PendingUpdate | null> {
  const raw = await getSetting<PendingUpdate | null>(PENDING_UPDATE_KEY, null).catch(() => null)
  if (!raw || !raw.filePath || !raw.version) return null

  if (compareVersions(current, raw.version) <= 0) {
    addRuntimeEvent('info', 'update', 'discarding a pending package that is no longer newer', {
      pending: raw.version,
      current,
    })
    await clearPending()
    return null
  }

  const usable = await bridge.verifyUpdatePackage(raw.filePath, raw.sha512 ?? null).catch(() => false)
  if (!usable) {
    addRuntimeEvent('info', 'update', 'previously downloaded package is gone or corrupt, will re-download')
    await clearPending()
    return null
  }
  return raw
}

async function ensureDownloaded(info: VersionInfo): Promise<void> {
  const version = info.latestVersion
  if (!version || !info.downloadUrl) return
  if (currentState.pending?.version === version) {
    addRuntimeEvent('info', 'update', 'package for this version is already on disk, not downloading again', { version })
    return
  }

  setState({ phase: 'downloading', error: null, downloadPercent: 0 })
  try {
    const filePath = await bridge.downloadUpdate(info.downloadUrl, info.sha512)
    await savePending({ version, filePath, sha512: info.sha512 })
    addRuntimeEvent('info', 'update', `version ${version} downloaded and ready to install`)
  } catch (err) {
    setState({ error: String(err) })
    addRuntimeEvent('warn', 'update', 'update download failed', { error: String(err) })
  }
}

async function runCheckAndDownload(): Promise<void> {
  if (currentState.phase === 'installing') return
  if (inFlight) { await inFlight; return }

  const current = readCurrentVersion()
  if (!current) {
    addRuntimeEvent('error', 'update', 'cannot read the app version, update check skipped')
    return
  }

  const task = (async () => {
    setState({ phase: 'checking', error: null })
    const info = await checkVersionUpdate(current)
    setState({ versionInfo: info, checkedAt: Date.now() })

    addRuntimeEvent(info.error ? 'warn' : 'info', 'update', 'update check finished', {
      current,
      latest: info.latestVersion,
      hasUpdate: info.hasUpdate,
      error: info.error,
      source: info.sourceUrl,
      configured: getUpdateBaseUrl(),
    })

    if (!info.hasUpdate || !info.downloadUrl) return
    await ensureDownloaded(info)
  })()

  inFlight = task
    .catch((err) => {
      addRuntimeEvent('error', 'update', 'update check threw', { error: String(err) })
      setState({ error: String(err) })
    })
    .finally(() => {
      inFlight = null
      if (currentState.phase === 'checking' || currentState.phase === 'downloading') {
        setState({ phase: 'idle' })
      }
    })
  await inFlight
}

export async function startUpdateService(): Promise<void> {
  try {
    const current = readCurrentVersion()
    //
    addRuntimeEvent(current ? 'info' : 'error', 'update', 'update service starting', {
      currentVersion: current ?? '(unreadable)',
      channel: getUpdateBaseUrl(),
    })

    if (!isOfficialUpdateChannel()) {
      addRuntimeEvent('info', 'update', 'update source follows a custom server address, not the official channel', {
        channel: getUpdateBaseUrl(),
        official: getOfficialUpdateBaseUrl(),
      })
    }

    const enabled = await getSetting('autoCheckUpdate', true).catch(() => true)
    if (!enabled) {
      addRuntimeEvent('warn', 'update', 'update checks disabled by the autoCheckUpdate setting')
      return
    }

    if (current) {
      const pending = await restorePending(current)
      if (pending) {
        addRuntimeEvent('info', 'update', 'reusing a package downloaded earlier', { version: pending.version })
        setState({ pending, downloadPercent: 100 })
      }
    }

    await runCheckAndDownload()

    if (checkTimer === null) {
      checkTimer = setInterval(() => { void runCheckAndDownload() }, CHECK_INTERVAL_MS)
    }
  } catch (err) {
    addRuntimeEvent('error', 'update', 'update service failed to start', { error: String(err) })
  }
}

export async function checkForUpdateNow(): Promise<VersionInfo | null> {
  await runCheckAndDownload()
  return currentState.versionInfo ?? null
}

export async function installPendingUpdate(): Promise<void> {
  const pending = currentState.pending
  if (!pending || currentState.phase === 'installing') return
  if (getRecorderState() !== 'idle') {
    setState({ installError: t('update.finishRecording'), error: t('update.finishRecording') })
    return
  }
  setState({ phase: 'installing', error: null, installError: null })
  try {
    await bridge.installDownloadedUpdate(pending.filePath, true)
  } catch (err) {
    setState({ phase: 'idle', error: String(err), installError: String(err) })
    addRuntimeEvent('error', 'update', 'failed to launch the installer', { error: String(err) })
  }
}
