import { useSyncExternalStore } from 'react'
import { Feedback } from './ui/feedback'
import {
  dismissToast, getFeedbackState, pauseToast, resumeToast, subscribeFeedback,
} from '@/services/actionFeedback'
import { useT } from '@/i18n/useT'

export function useActionPending(key: string) {
  return useSyncExternalStore(subscribeFeedback, getFeedbackState, getFeedbackState).actions[key] === 'pending'
}

export function SaveStatus({ actionKey }: { actionKey: string }) {
  const t = useT()
  const status = useSyncExternalStore(subscribeFeedback, getFeedbackState, getFeedbackState).actions[actionKey]
  if (!status || status === 'idle') return null
  return <p role="status" className={`my-2 text-xs ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
    {t(status === 'pending' ? 'feedback.saving' : status === 'error' ? 'feedback.saveFailed' : 'feedback.saved')}
  </p>
}

export function ToastViewport() {
  const t = useT()
  const { toasts } = useSyncExternalStore(subscribeFeedback, getFeedbackState, getFeedbackState)
  return <aside aria-label={t('feedback.notifications')}
    className="pointer-events-none fixed right-4 top-14 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
    {toasts.map((toast) => <div key={toast.id} className="pointer-events-auto"
      onMouseEnter={() => pauseToast(toast.id)}
      onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) resumeToast(toast.id) }}
      onFocusCapture={() => pauseToast(toast.id)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) resumeToast(toast.id) }}>
      <Feedback tone={toast.tone} message={toast.message}
        className={toast.tone === 'success' ? 'border-emerald-500/40 bg-card text-success-strong shadow-lg' : 'bg-card shadow-lg'}
        actions={[{ label: t('feedback.dismiss'), onClick: () => dismissToast(toast.id) }]} />
    </div>)}
  </aside>
}
