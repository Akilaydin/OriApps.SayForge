import { useEffect, useState, useSyncExternalStore } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@tauri-apps/api/core'
import { ExternalLink, Download, X } from 'lucide-react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/useT'
import { getState as getRecorderState } from '@/services/recorder'
import {
  cancelPendingInstallation, getUpdateStatus, installAvailableUpdate,
  postponeUpdate, subscribeUpdates, checkForUpdates,
} from '@/services/appUpdates'

const RELEASES_URL = 'https://github.com/Akilaydin/OriApps.SayForge/releases/latest'

export default function UpdatePrompt() {
  const t = useT()
  const update = useSyncExternalStore(subscribeUpdates, getUpdateStatus, getUpdateStatus)
  const [windowVisible, setWindowVisible] = useState(false)
  const [recorderIdle, setRecorderIdle] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let mounted = true
    const window = getCurrentWindow()
    const updateVisibility = () => {
      void window.isVisible().then((visible) => {
        if (mounted) setWindowVisible(visible)
      }).catch(() => { })
    }
    updateVisibility()
    const listener = window.onFocusChanged(() => updateVisibility())
    return () => {
      mounted = false
      void listener.then((unlisten) => unlisten()).catch(() => { })
    }
  }, [])

  useEffect(() => {
    if (update.phase !== 'available') return
    const refresh = () => setRecorderIdle(getRecorderState() === 'idle')
    refresh()
    const timer = setInterval(refresh, 700)
    return () => clearInterval(timer)
  }, [update.phase])

  if (!windowVisible) return null
  const { phase } = update
  if (phase === 'idle' || phase === 'checking' || phase === 'up-to-date') return null
  if (phase === 'available' && !recorderIdle) return null
  if (phase === 'error' && update.errorStage !== 'install') return null

  const busy = phase === 'downloading' || phase === 'waiting' || phase === 'installing'

  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-40 w-[min(400px,calc(100vw-2.5rem))] rounded-xl border border-border bg-card p-4 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {phase === 'error' ? t('updater.errorTitle') : t('updater.title')}
          </h3>
          {update.version && <p className="mt-1 text-sm text-muted-foreground">
            {t('updater.version', { current: __APP_VERSION__, next: update.version })}
          </p>}
        </div>
        {phase === 'available' && (
          <button aria-label={t('updater.later')} onClick={postponeUpdate} className="rounded p-1 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {phase === 'available' && (
        <>
          {update.notes && <p className="mt-2 max-h-24 overflow-auto whitespace-pre-line break-words text-xs text-muted-foreground">{update.notes}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void installAvailableUpdate()}>
              <Download className="mr-1.5 h-4 w-4" />{t('updater.install')}
            </Button>
            <Button size="sm" variant="outline" onClick={postponeUpdate}>{t('updater.later')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void shellOpen(RELEASES_URL)}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />{t('updater.changes')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('updater.restartNotice')}</p>
        </>
      )}
      {phase === 'downloading' && (
        <div className="mt-3 text-sm text-muted-foreground">
          <p>{t('updater.downloading')}{update.percent === undefined ? '' : ` ${update.percent}%`}</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${update.percent ?? 0}%` }} />
          </div>
        </div>
      )}
      {phase === 'waiting' && (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">{t('updater.waiting')}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={cancelPendingInstallation}>{t('updater.cancel')}</Button>
        </div>
      )}
      {phase === 'installing' && <p className="mt-3 text-sm text-muted-foreground">{t('updater.installing')}</p>}
      {phase === 'error' && (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">{t('updater.installFailed')}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void checkForUpdates(true)}>{t('updater.retry')}</Button>
        </div>
      )}
      {busy && <p className="mt-2 text-xs text-muted-foreground">{t('updater.keepOpen')}</p>}
    </aside>
  )
}
