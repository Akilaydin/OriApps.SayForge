
import { invoke } from '@tauri-apps/api/core'
import { getSetting, setSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { CloudAPIProvider } from './CloudAPIProvider'
import { LocalProvider } from './LocalProvider'
import type { TranscriptionProvider, WorkMode } from './types'

export type {
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
  FinalResult,
  ASRResult,
  WorkMode,
  ProviderState,
  AiExecutionSource,
  AiExecutionStatus,
} from './types'

let currentProvider: TranscriptionProvider | null = null
let currentMode: WorkMode = 'cloud_api'

/** Treat the removed Server Mode and unknown legacy values as Cloud API. */
export function normalizeWorkMode(stored: unknown): WorkMode {
  return stored === 'local' ? 'local' : 'cloud_api'
}

function createProvider(mode: WorkMode): TranscriptionProvider {
  switch (mode) {
    case 'cloud_api':
      return new CloudAPIProvider()
    case 'local':
      return new LocalProvider()
    default:
      addRuntimeEvent('warn', 'transcription', `Unknown processing mode "${mode}"; falling back to cloud API mode`)
      return new CloudAPIProvider()
  }
}

export function getProvider(): TranscriptionProvider {
  if (!currentProvider) {
    currentProvider = createProvider(currentMode)
  }
  return currentProvider
}

export function getWorkMode(): WorkMode {
  return currentMode
}

export async function switchProvider(mode: WorkMode): Promise<TranscriptionProvider> {
  if (mode === currentMode && currentProvider) {
    return currentProvider
  }

  addRuntimeEvent('info', 'transcription', 'Processing mode changed', { from: currentMode, to: mode })

  if (currentProvider) {
    try {
      currentProvider.disconnect()
    } catch {
      // ignore
    }
  }

  // Avoid leaving the local model loaded when switching to a cloud provider.
  if (currentMode === 'local' && mode !== 'local') {
    try {
      await invoke('unload_local_model')
    } catch (err) {
      addRuntimeEvent('warn', 'transcription', 'Failed to release local model', { error: String(err) })
    }
  }

  currentMode = mode
  currentProvider = createProvider(mode)
  return currentProvider
}

export async function initProviderFromStore(): Promise<void> {
  const stored = await getSetting('workMode', 'cloud_api')
  // Upgrade users of the removed Server Mode without connecting to a retired backend.
  // Persist the migration so other views observe the same effective mode.
  currentMode = normalizeWorkMode(stored)
  if (stored !== currentMode) {
    // Persist if possible, but do not block UI startup when storage is unavailable.
    await setSetting('workMode', currentMode).catch((error) => {
      addRuntimeEvent('warn', 'transcription', 'Could not persist legacy processing mode migration', {
        from: stored, to: currentMode, error: String(error),
      })
    })
  }
  currentProvider = createProvider(currentMode)
  addRuntimeEvent('info', 'transcription', 'Provider initialized', { mode: currentMode })
}
