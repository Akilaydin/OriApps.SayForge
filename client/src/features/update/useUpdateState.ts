
import { useSyncExternalStore } from 'react'
import { getAutoUpdateState, onAutoUpdateChange, type AutoUpdateState } from './autoUpdate'

export function useUpdateState(): AutoUpdateState {
  return useSyncExternalStore(onAutoUpdateChange, getAutoUpdateState)
}
