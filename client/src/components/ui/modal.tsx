//

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { useBackdropDismiss } from '@/hooks/useBackdropDismiss'
import { cn } from '@/lib/utils'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  title: string
  onClose: () => void
  locked?: boolean
  showCloseButton?: boolean
  panelClassName?: string
  children: ReactNode
}

export function Modal({
  title,
  onClose,
  locked,
  showCloseButton,
  panelClassName,
  children,
}: ModalProps) {
  const t = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`).current

  const requestClose = useCallback(() => {
    if (!locked) onClose()
  }, [locked, onClose])

  const backdropDismiss = useBackdropDismiss(requestClose)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const preferred = panel?.querySelector<HTMLElement>('[data-modal-autofocus]')
    const target = preferred?.matches(FOCUSABLE)
      ? preferred
      : preferred?.querySelector<HTMLElement>(FOCUSABLE)
      ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
      ; (target ?? panel)?.focus()

    return () => { previouslyFocused?.focus?.() }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        requestClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusables = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (focusables.length === 0) return
      const firstEl = focusables[0]
      const lastEl = focusables[focusables.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === firstEl || active === panelRef.current)) {
        event.preventDefault()
        lastEl.focus()
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault()
        firstEl.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [requestClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      {...backdropDismiss}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'relative max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-6 shadow-xl',
          panelClassName,
        )}
      >
        {showCloseButton && (
          <button
            type="button"
            onClick={requestClose}
            aria-label={t('window.close')}
            className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
        <h3 id={titleId} className="text-base font-semibold">{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  )
}
