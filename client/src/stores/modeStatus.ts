//
//

import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../services/store'
import { loadAsrProfiles } from '../features/settings/asrProfileStore'
import {
  describeAsrMissing,
  resolveActiveAsrProfile,
  resolveAsrModelOption,
  resolveAsrRuntimeProvider,
} from '../features/settings/asrProviderCatalog'
import { subscribeLocale, t } from '@/i18n'

export type ModeStatusMode = 'cloud_api' | 'local'

export interface ModeStatus {
  mode: ModeStatusMode
  detail: string
  ready: boolean | null
  blockedReason: string
}

type Listener = () => void

let currentStatus: ModeStatus = { mode: 'cloud_api', detail: '', ready: false, blockedReason: '' }
const listeners = new Set<Listener>()

function emitChange() {
  for (const listener of listeners) listener()
}

export function getModeStatus(): ModeStatus {
  return currentStatus
}

export function subscribeModeStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function cloudProviderShort(provider: string): string {
  switch (provider) {
    case 'openai_compat': return 'OpenAI-compatible'
    default: return provider
  }
}

export async function refreshModeStatus(): Promise<void> {
  const stored = await getSetting('workMode', 'cloud_api') as string
  const mode: ModeStatusMode =
    stored === 'local' ? 'local' : 'cloud_api'

  let detail = ''
  let ready: boolean | null = null
  let blockedReason = ''

  if (mode === 'local') {
    const modelId = await getSetting('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf') as string
    try {
      const models = await invoke<{ id: string; name: string }[]>('list_available_models')
      detail = models.find((m) => m.id === modelId)?.name ?? modelId
    } catch {
      detail = modelId
    }
    try {
      const downloaded = await invoke<{ id: string; complete: boolean }[]>('list_downloaded_models')
      ready = downloaded.some((m) => m.id === modelId && m.complete)
      if (!ready) blockedReason = t('modeStatus.modelNotDownloaded')
    } catch {
      ready = false
      blockedReason = t('modeStatus.modelListUnavailable')
    }
  } else if (mode === 'cloud_api') {
    const state = await loadAsrProfiles()
    const active = resolveActiveAsrProfile(state.profiles, state.activeId)
    if (!active) {
      detail = t('modeStatus.notConfigured')
      ready = false
      blockedReason = t('modeStatus.noAsrService')
    } else {
      detail = cloudProviderShort(resolveAsrRuntimeProvider(active))
      const missing = describeAsrMissing(active)
      const needsWorkspace = resolveAsrModelOption(active)?.needsWorkspaceId === true
        && active.workspaceId.trim() === ''
      ready = missing === '' && !needsWorkspace
      blockedReason = missing || (needsWorkspace ? t('modeStatus.noWorkspace') : '')
    }
  }

  if (
    currentStatus.mode === mode
    && currentStatus.detail === detail
    && currentStatus.ready === ready
    && currentStatus.blockedReason === blockedReason
  ) return
  currentStatus = { mode, detail, ready, blockedReason }
  emitChange()
}

subscribeLocale(() => { void refreshModeStatus() })
