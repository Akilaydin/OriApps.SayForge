import { useEffect, useRef, useState } from 'react'
import { invoke } from '@/services/bridge'
import { listen } from '@tauri-apps/api/event'
import { confirm, message } from '@tauri-apps/plugin-dialog'
import { AppWindow, Power } from 'lucide-react'
import { t } from '@/i18n'
import { useT } from '@/i18n/useT'
import { failureMessage } from '@/lib/errorMessages'


export default function TrayMenu() {
  useT()
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const commandBusy = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const unlistenOpen = listen('tray-menu-open', () => {
      requestAnimationFrame(() => firstItemRef.current?.focus())
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void invoke('hide_tray_menu')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      void unlistenOpen.then((fn) => fn())
    }
  }, [])

  const perform = async (command: 'show_main_from_tray' | 'quit_from_tray') => {
    if (commandBusy.current) return
    commandBusy.current = true; setBusy(true); setError('')
    try {
      if (command === 'quit_from_tray' && !await confirm(t('feedback.confirmQuit'), {
        title: t('feedback.confirmTitle'), kind: 'warning', okLabel: t('tray.quit'), cancelLabel: t('common.cancel'),
      })) return
      await invoke(command)
    }
    catch (error) {
      const description = failureMessage(error, t(command === 'quit_from_tray' ? 'tray.quitFailed' : 'feedback.actionFailed'))
      if (command === 'quit_from_tray') {
        // The fixed-size tray menu cannot display a multiline recovery message.
        await message(description, { title: t('tray.quit'), kind: 'error' }).catch(() => setError(description))
      } else setError(description)
    }
    finally { commandBusy.current = false; setBusy(false) }
  }

  return (
    <div className="tray-menu-shell" role="menu" aria-label="SayForge">
      <button ref={firstItemRef} disabled={busy} className="tray-menu-item" role="menuitem" onClick={() => void perform('show_main_from_tray')}>
        <span className="tray-menu-leading" aria-hidden>
          <AppWindow size={14} strokeWidth={1.8} />
        </span>
        <span>{t('tray.open')}</span>
      </button>

      <div className="tray-menu-divider" role="separator" />

      <button disabled={busy} className="tray-menu-item tray-menu-quit" role="menuitem" onClick={() => void perform('quit_from_tray')}>
        <span className="tray-menu-leading" aria-hidden>
          <Power size={14} strokeWidth={1.8} />
        </span>
        <span>{t('tray.quit')}</span>
      </button>
      {error && <p role="alert" className="px-3 py-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
