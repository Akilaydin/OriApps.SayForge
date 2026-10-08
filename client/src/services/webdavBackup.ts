//
//

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { t, type TranslationKey } from '@/i18n'

export const JIANGUOYUN_DAV_BASE = 'https://dav.jianguoyun.com/dav'

export const DEFAULT_DAV_URL = `${JIANGUOYUN_DAV_BASE}/SayForge`

export interface WebDavConfig {
  url: string
  username: string
  password: string
}

export interface WebDavEntry {
  name: string
  size: number
}

export interface WebDavBackupResult {
  fileName: string
  bytes: number
  includeHistory: boolean
  includeAudio: boolean
  finishedAt: number
  pruned: number
}

export interface WebDavLastResult {
  at: number
  ok: boolean
  fileName: string
  bytes: number
  includeHistory: boolean
  includeAudio: boolean
  error: string | null
}

export interface WebDavProgress {
  status: 'running' | 'completed' | 'failed'
  phase:
  | 'preparing'
  | 'packingData'
  | 'packingAudio'
  | 'finalizing'
  | 'uploading'
  | 'verifying'
  | 'completed'
  | 'failed'
  fileName: string
  currentFile: string | null
  processedBytes: number
  totalBytes: number
  percent: number
  error: string | null
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  WEBDAV_URL_EMPTY: 'webdav.error.urlEmpty',
  WEBDAV_URL_INSECURE: 'webdav.error.urlInsecure',
  WEBDAV_URL_SCHEME: 'webdav.error.urlScheme',
  WEBDAV_CREDENTIALS_EMPTY: 'webdav.error.credentialsEmpty',
  WEBDAV_UNAUTHORIZED: 'webdav.error.unauthorized',
  WEBDAV_MKCOL_CONFLICT: 'webdav.error.mkcolConflict',
  WEBDAV_VERIFY_MISSING: 'webdav.error.verifyMissing',
  WEBDAV_VERIFY_SIZE: 'webdav.error.verifySize',
  WEBDAV_EMPTY_DOWNLOAD: 'webdav.error.emptyDownload',
  WEBDAV_BAD_NAME: 'webdav.error.badName',
}

export function describeWebDavError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = raw.trim()
  const key = ERROR_KEYS[code]
  return key ? t(key) : raw
}

export function onWebDavBackupProgress(
  handler: (progress: WebDavProgress) => void,
): Promise<UnlistenFn> {
  return listen<WebDavProgress>('webdav-backup-progress', (event) => handler(event.payload))
}

export function testWebDavConnection(config: WebDavConfig): Promise<number> {
  return invoke<number>('webdav_test', { config })
}

export function listWebDavBackups(): Promise<WebDavEntry[]> {
  return invoke<WebDavEntry[]>('webdav_list')
}

export function runWebDavBackup(): Promise<WebDavBackupResult> {
  return invoke<WebDavBackupResult>('webdav_backup_now')
}

export function restoreWebDavBackup(name: string): Promise<void> {
  return invoke('webdav_restore', { name })
}
