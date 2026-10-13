import { confirm } from '@tauri-apps/plugin-dialog'
import { t } from '@/i18n'
import type { FeedbackTone } from '@/components/ui/feedback'
import { reportRuntimeFailure } from './debugLog'
import { failureMessage } from '@/lib/errorMessages'

export interface Toast { id: number; tone: FeedbackTone; message: string }
type ActionState = 'pending' | 'success' | 'error' | 'idle'
let state: { toasts: Toast[]; actions: Record<string, ActionState> } = { toasts: [], actions: {} }
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const paused = new Set<number>()
let nextId = 0

export const getFeedbackState = () => state
export function subscribeFeedback(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish() { listeners.forEach((listener) => listener()) }
function actionState(key: string, value: ActionState) {
  state = { ...state, actions: { ...state.actions, [key]: value } }
  publish()
}
export function dismissToast(id: number) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  paused.delete(id)
  state = { ...state, toasts: state.toasts.filter((toast) => toast.id !== id) }
  publish()
}
export function pauseToast(id: number) { clearTimeout(timers.get(id)); timers.delete(id); paused.add(id) }
export function resumeToast(id: number) {
  paused.delete(id)
  scheduleToast(id)
}
function scheduleToast(id: number) {
  clearTimeout(timers.get(id))
  if (paused.has(id)) return
  const toast = state.toasts.find((item) => item.id === id)
  if (toast) timers.set(id, setTimeout(() => dismissToast(id), toast.tone === 'error' ? 10_000 : 5_000))
}
export function showToast(tone: FeedbackTone, message: string) {
  const duplicate = state.toasts.find((toast) => toast.tone === tone && toast.message === message)
  if (duplicate) { scheduleToast(duplicate.id); return }
  if (state.toasts.length === 3) dismissToast(state.toasts[0].id)
  const toast = { id: ++nextId, tone, message }
  state = { ...state, toasts: [...state.toasts, toast] }
  publish()
  resumeToast(toast.id)
}

interface ActionMessages {
  success?: string
  error?: string
  canceled?: string
  confirmation?: string
}

/** False from an operation means canceled; only fulfilled work can announce success. */
export async function runAction(
  key: string,
  operation: () => Promise<unknown>,
  messages: ActionMessages = {},
): Promise<boolean> {
  if (state.actions[key] === 'pending') return false
  actionState(key, 'pending')
  try {
    if (messages.confirmation && !await confirm(messages.confirmation, {
      title: t('feedback.confirmTitle'), kind: 'warning',
      okLabel: t('feedback.continue'), cancelLabel: t('common.cancel'),
    })) {
      actionState(key, 'idle')
      return false
    }
    if (await operation() === false) {
      actionState(key, 'idle')
      if (messages.canceled) showToast('info', messages.canceled)
      return false
    }
    actionState(key, 'success')
    if (messages.success) showToast('success', messages.success)
    return true
  } catch (error) {
    reportRuntimeFailure('action', key, error)
    actionState(key, 'error')
    // Never put provider responses, API keys or user text in a notification.
    showToast('error', failureMessage(error, messages.error ?? t('feedback.actionFailed')))
    return false
  }
}
