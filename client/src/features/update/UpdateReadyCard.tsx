import { Loader2, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/useT'
import appIcon from '@/assets/icon-128.png'
import type { UpdateNotificationData } from './notificationTypes'

interface Props {
  data: UpdateNotificationData
  onInstall: () => void
  onDismiss: () => void
  sending?: boolean
  actionFailed?: boolean
}

export default function UpdateReadyCard({ data, onInstall, onDismiss, sending, actionFailed }: Props) {
  const t = useT()
  const busy = data.installing || sending

  return (
    <section className="update-ready-card" role="region" aria-labelledby="update-ready-title" aria-busy={busy}>
      <button
        type="button"
        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        onClick={onDismiss}
        disabled={busy}
        aria-label={t('update.dismiss')}
        title={t('update.dismiss')}
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>

      <div className="update-ready-mark" aria-hidden="true">
        <img src={appIcon} alt="" className="h-6 w-6 rounded-lg" />
      </div>

      <div className="mt-2" aria-live="polite">
        <h2 id="update-ready-title" className="px-1 text-[13px] font-medium leading-5 tracking-[-0.01em]">
          {t('update.readyTitle')}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center justify-center gap-x-1.5 text-[11px] leading-4 tabular-nums text-muted-foreground">
          <span>v{data.currentVersion}</span>
          <span className="text-muted-foreground/60">→</span>
          <span className="font-medium text-foreground/80">v{data.version}</span>
        </p>
        {(data.installFailed || actionFailed) && (
          <p className="mt-2 text-xs leading-relaxed text-destructive-strong" role="alert">
            {t(actionFailed ? 'update.actionFailed' : 'update.installFailed')}
          </p>
        )}
      </div>

      <Button
        className="update-ready-action mt-2.5 h-7 min-w-[64px] gap-1 rounded-full px-2.5 text-xs"
        onClick={onInstall}
        disabled={busy}
        title={t('update.restartHint')}
      >
        {busy
          ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          : <RotateCw className="h-3 w-3" aria-hidden />}
        {t(busy ? 'update.restarting' : 'update.restartNow')}
      </Button>
    </section>
  )
}
