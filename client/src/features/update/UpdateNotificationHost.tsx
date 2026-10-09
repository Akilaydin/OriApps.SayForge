import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getLocale } from '@/i18n'
import { getActiveThemeId } from '@/stores/theme'
import { getState as getRecorderState } from '@/services/recorder'
import { syncUpdateNotification } from '@/services/bridge'
import { addRuntimeEvent } from '@/services/debugLog'
import { getAutoUpdateState, installPendingUpdate, onAutoUpdateChange } from './autoUpdate'
import { UpdateNotificationController } from './notificationController'
import { UPDATE_NOTIFICATION_ACTION, type UpdateNotificationAction } from './notificationTypes'

export default function UpdateNotificationHost({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return
    const controller = new UpdateNotificationController({
      readUpdate: getAutoUpdateState,
      isIdle: () => getRecorderState() === 'idle',
      appearance: () => ({
        currentVersion: __APP_VERSION__,
        theme: getActiveThemeId(),
        locale: getLocale(),
      }),
      publish: syncUpdateNotification,
      install: installPendingUpdate,
      onError: (error) => addRuntimeEvent('warn', 'update-notification', 'notification failed', { error: String(error) }),
    })
    const unsubscribe = onAutoUpdateChange(() => controller.tick())
    const unlisten = listen<UpdateNotificationAction>(UPDATE_NOTIFICATION_ACTION, ({ payload }) => {
      void controller.act(payload)
    })
    const timer = setInterval(() => controller.tick(), 500)
    controller.tick()
    return () => {
      clearInterval(timer)
      unsubscribe()
      controller.stop()
      void unlisten.then((stop) => stop())
    }
  }, [enabled])
  return null
}
