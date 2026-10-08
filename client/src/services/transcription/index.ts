
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { ServerProvider } from './ServerProvider'
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
export { MID_SESSION_DISCONNECT_ERROR } from './types'

let currentProvider: TranscriptionProvider | null = null
let currentMode: WorkMode = 'server'

function createProvider(mode: WorkMode): TranscriptionProvider {
  switch (mode) {
    case 'server':
      return new ServerProvider()
    case 'cloud_api':
      return new CloudAPIProvider()
    case 'local':
      return new LocalProvider()
    default:
      addRuntimeEvent('warn', 'transcription', `Unknown processing mode "${mode}"; falling back to server mode`)
      return new ServerProvider()
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
  const stored = await getSetting('workMode', 'server')
  const mode = (stored === 'server' || stored === 'cloud_api' || stored === 'local') ? stored : 'server'
  currentMode = mode as WorkMode
  currentProvider = createProvider(currentMode)
  addRuntimeEvent('info', 'transcription', 'Provider initialized', { mode: currentMode })
}
