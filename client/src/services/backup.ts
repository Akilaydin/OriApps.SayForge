//

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { TextReplacementRule } from './textReplacement'
import { t } from '@/i18n'

export interface ExportResult {
  canceled: boolean
  filePath: string | null
}

export type ConfigExportSelection =
  | { mode: 'full' }
  | {
    mode: 'selected'
    hotwordGroupIds: string[]
    includeTextReplacements: boolean
    textReplacements?: TextReplacementRule[]
    promptPresetIds: string[]
  }

export interface ConfigImportSectionPreview {
  kind: string
  total: number
  added: number
  updated: number
  skipped: number
}

export interface ConfigImportWarning {
  code: 'hotwordLimit' | 'fullOverwrite' | string
  current: number | null
  limit: number | null
}

export interface ConfigImportPreview {
  scope: 'full' | 'selected'
  formatVersion: number
  importToken: string
  sections: ConfigImportSectionPreview[]
  warnings: ConfigImportWarning[]
  requiresRestart: boolean
}

export interface ConfigImportResult {
  changedSections: string[]
  added: number
  updated: number
  skipped: number
  requiresRestart: boolean
}

export interface BackupExportProgress {
  status: 'running' | 'completed' | 'failed'
  phase: 'preparing' | 'packingData' | 'packingAudio' | 'finalizing' | 'completed' | 'failed'
  filePath: string
  currentFile: string | null
  processedFiles: number
  totalFiles: number
  processedBytes: number
  totalBytes: number
  percent: number
  error: string | null
}

export function getBackupDirectory(): Promise<string> {
  return invoke<string>('get_backup_directory')
}

export function onBackupExportProgress(
  handler: (progress: BackupExportProgress) => void,
): Promise<UnlistenFn> {
  return listen<BackupExportProgress>('backup-export-progress', (event) => handler(event.payload))
}

export async function exportConfigFile(selection: ConfigExportSelection): Promise<ExportResult> {
  const path = await invoke<string>('export_config', { selection })
  return { canceled: false, filePath: path }
}

export async function exportFullFile(): Promise<ExportResult> {
  const path = await invoke<string>('export_full', {
    scope: { includeHistory: true, includeAudio: true },
  })
  return { canceled: false, filePath: path }
}

export async function pickImportFile(kind: 'config' | 'full'): Promise<string | null> {
  const filters =
    kind === 'config'
      ? [{ name: t('configTransfer.fileConfig'), extensions: ['json'] }]
      : [{ name: t('configTransfer.fileBackup'), extensions: ['zip'] }]
  const picked = await open({ multiple: false, directory: false, filters })
  return typeof picked === 'string' ? picked : null
}

export function inspectConfigImport(inPath: string): Promise<ConfigImportPreview> {
  return invoke<ConfigImportPreview>('inspect_config_import', { inPath })
}

export async function runImport(
  kind: 'config' | 'full',
  inPath: string,
  expectedImportToken?: string,
): Promise<ConfigImportResult | null> {
  if (kind === 'config') {
    if (!expectedImportToken) throw new Error(t('configTransfer.missingConfirmation'))
    return invoke<ConfigImportResult>('import_config', { inPath, expectedImportToken })
  }
  await invoke('import_full', { inPath })
  return null
}

export function restartApp(): Promise<void> {
  return invoke('restart_app')
}
