
import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { getSetting, setSetting } from '@/services/store'
import { useT } from '@/i18n/useT'

export default function HotwordPromptInjectToggle() {
  const t = useT()
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    getSetting('injectHotwordsToPrompt', false)
      .then((v) => setEnabled(Boolean(v)))
      .finally(() => {
        setReady(true)
        requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)))
      })
  }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    void setSetting('injectHotwordsToPrompt', next)
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <h2 className="text-lg font-semibold">{t('hotwordInject.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('hotwordInject.desc')}
            </p>
          </div>
          <Switch checked={enabled} onChange={toggle} noAnimation={!animate} hidden={!ready} />
        </div>
      </CardContent>
    </Card>
  )
}
