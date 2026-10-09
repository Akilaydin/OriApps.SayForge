//
//

import type { ReactNode } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export type FeedbackTone = 'success' | 'error' | 'warning' | 'info'

const TONE_STYLES: Record<
  FeedbackTone,
  { box: string; text: string; icon: string; Icon: typeof Info }
> = {
  success: {
    box: 'border-border bg-muted/40',
    text: 'text-foreground',
    icon: 'text-success-strong',
    Icon: CheckCircle2,
  },
  error: {
    box: 'border-destructive/25 bg-destructive/5',
    text: 'text-foreground',
    icon: 'text-destructive-strong',
    Icon: XCircle,
  },
  warning: {
    box: 'border-warning/25 bg-warning/5',
    text: 'text-foreground',
    icon: 'text-warning-strong',
    Icon: AlertTriangle,
  },
  info: {
    box: 'border-border bg-muted/40',
    text: 'text-muted-foreground',
    icon: 'text-muted-foreground',
    Icon: Info,
  },
}

export interface FeedbackAction {
  label: string
  onClick: () => void
  disabled?: boolean
}

interface FeedbackProps {
  tone: FeedbackTone
  message: ReactNode
  detail?: string
  actions?: FeedbackAction[]
  className?: string
}

export function FormatHint({ text }: { text: string }) {
  return (
    <p className="mt-1.5 flex items-start gap-1 text-xs text-warning-strong">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      {text}
    </p>
  )
}

export function Feedback({ tone, message, detail, actions, className }: FeedbackProps) {
  const style = TONE_STYLES[tone]
  const Icon = style.Icon

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={cn('rounded-md border px-3 py-2.5', style.box, className)}
    >
      <div className="flex gap-2">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.icon)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm leading-relaxed', style.text)}>{message}</p>

          {detail && (
            <p className="mt-1.5 whitespace-pre-line break-words text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          )}

          {actions && actions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
