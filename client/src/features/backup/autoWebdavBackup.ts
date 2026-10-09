//
//
//

import { getSetting, setSetting } from '@/services/store'
import { addRuntimeEvent } from '@/services/debugLog'
import {
  runWebDavBackup,
  type WebDavBackupResult,
  type WebDavLastResult,
} from '@/services/webdavBackup'

const KEY_LAST_BACKUP_AT = 'webdav.lastBackupAt'
const KEY_LAST_ATTEMPT_AT = 'webdav.lastAttemptAt'

const TICK_MS = 15 * 60 * 1000

const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000

const FAILURE_BACKOFF_MS = 60 * 60 * 1000

export interface WebDavBackupState {
  running: boolean
  lastResult: WebDavLastResult | null
}

let currentState: WebDavBackupState = { running: false, lastResult: null }
const listeners = new Set<(state: WebDavBackupState) => void>()
let inFlight: Promise<WebDavBackupResult | null> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null

function setState(patch: Partial<WebDavBackupState>) {
  currentState = { ...currentState, ...patch }
  listeners.forEach((cb) => cb(currentState))
}

export function getWebDavBackupState(): WebDavBackupState {
  return currentState
}

export function onWebDavBackupChange(cb: (state: WebDavBackupState) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export async function refreshLastResult(): Promise<WebDavLastResult | null> {
  const value = await getSetting<WebDavLastResult | null>('webdav.lastResult', null).catch(() => null)
  const lastResult = value && typeof value === 'object' ? value : null
  setState({ lastResult })
  return lastResult
}

export async function runBackupNow(trigger: 'manual' | 'schedule'): Promise<WebDavBackupResult | null> {
  if (inFlight) return inFlight

  const task = (async (): Promise<WebDavBackupResult | null> => {
    setState({ running: true })
    const startedAt = Date.now()
    await setSetting(KEY_LAST_ATTEMPT_AT, startedAt).catch(() => undefined)
    try {
      const result = await runWebDavBackup()
      await setSetting(KEY_LAST_BACKUP_AT, Date.now()).catch(() => undefined)
      addRuntimeEvent('info', 'webdav', 'backup finished', {
        trigger,
        fileName: result.fileName,
        bytes: result.bytes,
        includeHistory: result.includeHistory,
        includeAudio: result.includeAudio,
        pruned: result.pruned,
        elapsedMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      addRuntimeEvent('error', 'webdav', 'backup failed', { trigger, error: String(error) })
      return null
    }
  })()

  inFlight = task
  try {
    return await task
  } finally {
    inFlight = null
    setState({ running: false })
    await refreshLastResult()
  }
}

async function shouldBackupNow(): Promise<boolean> {
  const enabled = await getSetting('webdav.enabled', false).catch(() => false)
  if (!enabled) return false

  const [url, username, password] = await Promise.all([
    getSetting('webdav.url', '').catch(() => ''),
    getSetting('webdav.username', '').catch(() => ''),
    getSetting('webdav.password', '').catch(() => ''),
  ])
  if (!url.trim() || !username.trim() || !password) return false

  const now = Date.now()
  const lastAttemptAt = await getSetting(KEY_LAST_ATTEMPT_AT, 0).catch(() => 0)
  const lastBackupAt = await getSetting(KEY_LAST_BACKUP_AT, 0).catch(() => 0)

  if (lastAttemptAt > lastBackupAt && now - lastAttemptAt < FAILURE_BACKOFF_MS) return false

  const intervalHours = await getSetting('webdav.intervalHours', 24).catch(() => 24)
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000
  return now - lastBackupAt >= intervalMs
}

async function tick() {
  try {
    if (await shouldBackupNow()) {
      await runBackupNow('schedule')
    }
  } catch (error) {
    addRuntimeEvent('error', 'webdav', 'backup tick threw', { error: String(error) })
  }
}

export async function startWebDavBackupService(): Promise<void> {
  try {
    await refreshLastResult()
    const enabled = await getSetting('webdav.enabled', false).catch(() => false)
    addRuntimeEvent('info', 'webdav', 'backup service starting', {
      enabled,
      intervalHours: await getSetting('webdav.intervalHours', 24).catch(() => 24),
      includeHistory: await getSetting('webdav.includeHistory', false).catch(() => false),
      includeAudio: await getSetting('webdav.includeAudio', false).catch(() => false),
      lastBackupAt: await getSetting(KEY_LAST_BACKUP_AT, 0).catch(() => 0),
    })

    if (firstCheckTimer === null) {
      firstCheckTimer = setTimeout(() => { void tick() }, FIRST_CHECK_DELAY_MS)
    }
    if (tickTimer === null) {
      tickTimer = setInterval(() => { void tick() }, TICK_MS)
    }
  } catch (error) {
    addRuntimeEvent('error', 'webdav', 'backup service failed to start', { error: String(error) })
  }
}
