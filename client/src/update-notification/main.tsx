import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { emitTo, listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import { applyTheme } from '@/themes'
import { isLocale, setLocale } from '@/i18n'
import { getUpdateNotification, fitUpdateNotification } from '@/services/bridge'
import UpdateReadyCard from '@/features/update/UpdateReadyCard'
import { UPDATE_NOTIFICATION_ACTION, UPDATE_NOTIFICATION_EVENT, UPDATE_NOTIFICATION_WIDTH, type UpdateNotificationSnapshot } from '@/features/update/notificationTypes'
import '@/index.css'
import './notification.css'

const preview = import.meta.env.DEV && !isTauri()
if (preview) document.documentElement.classList.add('update-notification-preview')
const params = new URLSearchParams(location.search)
const previewLocale = params.get('locale')
const initial: UpdateNotificationSnapshot = preview ? {
  revision: 1,
  data: {
    version: '0.2.2',
    currentVersion: __APP_VERSION__,
    theme: params.get('theme') || 'light',
    locale: isLocale(previewLocale) ? previewLocale : 'en',
    installing: params.get('state') === 'installing',
    installFailed: params.get('state') === 'error',
  },
} : { revision: 0, data: null }

function Notification() {
  const [snapshot, setSnapshot] = useState(initial)
  const [sending, setSending] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const shell = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (preview) return
    let disposed = false
    let stop: (() => void) | undefined
    const apply = (next: UpdateNotificationSnapshot) => {
      if (!disposed) setSnapshot((current) => next.revision >= current.revision ? next : current)
    }
    void (async () => {
      stop = await listen<UpdateNotificationSnapshot>(UPDATE_NOTIFICATION_EVENT, ({ payload }) => apply(payload))
      if (disposed) { stop(); return }
      apply(await getUpdateNotification())
    })().catch(console.error)
    return () => { disposed = true; stop?.() }
  }, [])

  useLayoutEffect(() => {
    if (!snapshot.data) return
    applyTheme(snapshot.data.theme)
    setLocale(snapshot.data.locale)
  }, [snapshot.data?.theme, snapshot.data?.locale])

  useEffect(() => {
    if (preview || !shell.current || !snapshot.data) return
    const element = shell.current
    const resize = () => {
      const bounds = element.getBoundingClientRect()
      void fitUpdateNotification(snapshot.revision, UPDATE_NOTIFICATION_WIDTH, bounds.height, window.devicePixelRatio).catch(console.error)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const frame = requestAnimationFrame(resize)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
    }
  }, [snapshot])

  const act = async (action: 'install' | 'later') => {
    if (!snapshot.data || sending || snapshot.data.installing) return
    setSending(true)
    setActionFailed(false)
    try {
      if (preview) {
        setSnapshot((current) => ({
          revision: current.revision + 1,
          data: action === 'later' ? null : current.data && { ...current.data, installing: true, installFailed: false },
        }))
      } else {
        await emitTo('main', UPDATE_NOTIFICATION_ACTION, { action, version: snapshot.data.version })
      }
    } catch {
      setActionFailed(true)
    } finally {
      setSending(false)
    }
  }

  if (!snapshot.data) return null
  return (
    <div ref={shell} className="update-notification-shell" style={{ width: UPDATE_NOTIFICATION_WIDTH }} onKeyDown={(event) => {
      if (event.key === 'Escape') void act('later')
    }}>
      <UpdateReadyCard data={snapshot.data} sending={sending} actionFailed={actionFailed} onInstall={() => void act('install')} onDismiss={() => void act('later')} />
    </div>
  )
}

window.addEventListener('contextmenu', (event) => event.preventDefault())
createRoot(document.getElementById('root')!).render(<Notification />)
