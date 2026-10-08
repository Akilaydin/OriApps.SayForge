// Provider 管理器 — 根据 workMode 返回对应的 TranscriptionProvider

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

/** 获取当前 Provider 实例（懒初始化） */
export function getProvider(): TranscriptionProvider {
  if (!currentProvider) {
    currentProvider = createProvider(currentMode)
  }
  return currentProvider
}

/** 获取当前工作模式 */
export function getWorkMode(): WorkMode {
  return currentMode
}

/**
 * 切换工作模式。
 * 会断开旧 Provider 并创建新的。
 * 调用方需要重新 connect。
 */
export async function switchProvider(mode: WorkMode): Promise<TranscriptionProvider> {
  if (mode === currentMode && currentProvider) {
    return currentProvider
  }

  addRuntimeEvent('info', 'transcription', 'Processing mode changed', { from: currentMode, to: mode })

  // 断开旧 Provider
  if (currentProvider) {
    try {
      currentProvider.disconnect()
    } catch {
      // ignore
    }
  }

  // 离开本地模式时释放 sherpa-onnx recognizer 占用的内存（几百 MB ~ 数 GB），
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

/** 从 store 读取保存的 workMode 并初始化 */
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
