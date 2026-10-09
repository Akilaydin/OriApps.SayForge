import { useSyncExternalStore } from 'react'
import { subscribeAiEnabled, getAiEnabled, getAiEnabledReady } from '@/stores/aiEnabled'

export function useAiEnabled() {
  return useSyncExternalStore(subscribeAiEnabled, getAiEnabled)
}

export function useAiEnabledReady() {
  return useSyncExternalStore(subscribeAiEnabled, getAiEnabledReady)
}
