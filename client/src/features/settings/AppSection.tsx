import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/i18n/useT'

export default function AppSection({
  autoLaunch,
  onToggleAutoLaunch,
  ready = true,
  animate = true,
  busy = false,
  error = '',
  onRetry,
}: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  ready?: boolean
  animate?: boolean
  busy?: boolean
  error?: string
  onRetry?: () => void
}) {
  const t = useT()
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.app.title')}</h2>
        <div className="flex items-center justify-between">
          <div>
            <p id="auto-launch-label" className="text-sm font-medium">{t('settings.app.autoLaunch')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.app.autoLaunchDesc')}</p>
          </div>
          <Switch checked={autoLaunch} onChange={onToggleAutoLaunch} noAnimation={!animate} hidden={!ready} disabled={busy} labelledBy="auto-launch-label" />
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error} <button type="button" className="underline" disabled={busy} onClick={onRetry}>{t('common.retry')}</button></p>}
      </CardContent>
    </Card>
  )
}
