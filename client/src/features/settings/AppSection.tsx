import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/i18n/useT'

export default function AppSection({
  autoLaunch,
  onToggleAutoLaunch,
  ready = true,
  animate = true,
}: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  ready?: boolean
  animate?: boolean
}) {
  const t = useT()
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.app.title')}</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('settings.app.autoLaunch')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.app.autoLaunchDesc')}</p>
          </div>
          <Switch checked={autoLaunch} onChange={onToggleAutoLaunch} noAnimation={!animate} hidden={!ready} />
        </div>
      </CardContent>
    </Card>
  )
}
