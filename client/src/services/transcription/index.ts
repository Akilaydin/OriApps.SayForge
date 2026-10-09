
import { getSetting, setSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { CloudAPIProvider } from './CloudAPIProvider'
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

/** Treat the removed local/server modes and unknown legacy values as Cloud API. */
export function normalizeWorkMode(_stored: unknown): WorkMode {
  return 'cloud_api'
}

function createProvider(_mode: WorkMode): TranscriptionProvider {
  return new CloudAPIProvider()
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
