import type { UpdateStatus } from '@/services/appUpdates'

export function showUpdatePrompt(update: UpdateStatus, windowVisible: boolean, recorderIdle: boolean): boolean {
  if (!windowVisible || ['idle', 'checking', 'up-to-date'].includes(update.phase)) return false
  if (update.phase === 'available' && !recorderIdle) return false
  // Manual check failures, including Retry outside About, must remain visible.
  return true
}

export function updateErrorMessageKey(errorStage: UpdateStatus['errorStage']): 'updater.checkFailed' | 'updater.installFailed' {
  return errorStage === 'check' ? 'updater.checkFailed' : 'updater.installFailed'
}
