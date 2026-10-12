import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AppWindow, Power } from 'lucide-react'
import { t } from '@/i18n'
import { useT } from '@/i18n/useT'


export default function TrayMenu() {
  useT()
  const firstItemRef = useRef<HTMLButtonElement>(null)

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

  const openMain = () => void invoke('show_main_from_tray')

  const quit = () => void invoke('quit_from_tray')

  return (
    <div className="tray-menu-shell" role="menu" aria-label="SayForge">
      <button ref={firstItemRef} className="tray-menu-item" role="menuitem" onClick={openMain}>
        <span className="tray-menu-leading" aria-hidden>
          <AppWindow size={14} strokeWidth={1.8} />
        </span>
        <span>{t('tray.open')}</span>
      </button>

      <div className="tray-menu-divider" role="separator" />

      <button className="tray-menu-item tray-menu-quit" role="menuitem" onClick={quit}>
        <span className="tray-menu-leading" aria-hidden>
          <Power size={14} strokeWidth={1.8} />
        </span>
        <span>{t('tray.quit')}</span>
      </button>
    </div>
  )
}
