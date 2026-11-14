import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import {
  isAiCorrectionConfigured,
  loadAiCorrectionSettings,
  saveAiCorrectionSettings,
  type AiCorrectionSettings,
} from '@/services/aiCorrectionSettings'
import { useT } from '@/i18n/useT'

const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'

export default function AiCorrectionSection() {
  const t = useT()
  const [settings, setSettings] = useState<AiCorrectionSettings | null>(null)
  const [baseline, setBaseline] = useState<AiCorrectionSettings | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void loadAiCorrectionSettings().then((loaded) => {
      if (!active) return
      setSettings(loaded)
      setBaseline(loaded)
    }).catch(() => {
      if (active) setLoadError(true)
    })
    return () => { active = false }
  }, [])

  const patch = (next: Partial<AiCorrectionSettings>) => {
    setSettings((current) => current ? { ...current, ...next } : current)
    setSaveError(false)
    setSaved(false)
  }

  const dirty = settings && baseline && (
    settings.enabled !== baseline.enabled
    || settings.apiUrl !== baseline.apiUrl
    || settings.apiKey !== baseline.apiKey
    || settings.model !== baseline.model
    || settings.prompt !== baseline.prompt
  )

  const save = async () => {
    if (!settings || !dirty || saving) return
    setSaving(true)
    setSaveError(false)
    try {
      await saveAiCorrectionSettings(settings)
      setBaseline(settings)
      setSaved(true)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="ai-correction-label" className="text-lg font-semibold">{t('settings.aiCorrection.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.aiCorrection.desc')}</p>
          </div>
          {settings && (
            <Switch
              checked={settings.enabled}
              onChange={() => patch({ enabled: !settings.enabled })}
              labelledBy="ai-correction-label"
              disabled={saving}
            />
          )}
        </div>

        {!settings && (
          <p role={loadError ? 'alert' : 'status'} className={loadError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {t(loadError ? 'settings.aiCorrection.loadFailed' : 'settings.aiCorrection.loading')}
          </p>
        )}

        {settings && (
          <fieldset disabled={saving} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="ai-correction-url" className="text-sm font-medium">{t('settings.aiCorrection.apiUrl')}</label>
                <input
                  id="ai-correction-url"
                  type="url"
                  className={inputClass}
                  value={settings.apiUrl}
                  onChange={(event) => patch({ apiUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ai-correction-model" className="text-sm font-medium">{t('settings.aiCorrection.model')}</label>
                <input
                  id="ai-correction-model"
                  className={inputClass}
                  value={settings.model}
                  onChange={(event) => patch({ model: event.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ai-correction-key" className="text-sm font-medium">{t('settings.aiCorrection.apiKey')}</label>
              <PasswordInput
                id="ai-correction-key"
                label={t('settings.aiCorrection.apiKey')}
                value={settings.apiKey}
                onChange={(apiKey) => patch({ apiKey })}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ai-correction-prompt" className="text-sm font-medium">{t('settings.aiCorrection.prompt')}</label>
              <textarea
                id="ai-correction-prompt"
                rows={4}
                className="w-full rounded-md border border-input-border bg-input-bg p-3 text-sm transition-colors focus:border-input-focus-border"
                value={settings.prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
              />
            </div>
            {settings.enabled && !isAiCorrectionConfigured(settings) && (
              <p className="text-xs text-warning-strong">{t('settings.aiCorrection.missingConfig')}</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void save()} disabled={!dirty || saving}>
                {t(saving ? 'common.saving' : 'common.save')}
              </Button>
              {dirty && <p className="text-xs text-muted-foreground">{t('settings.aiCorrection.unsaved')}</p>}
              {saved && <p role="status" className="text-xs text-muted-foreground">{t('feedback.saved')}</p>}
              {saveError && <p role="alert" className="text-xs text-destructive">{t('feedback.saveFailed')}</p>}
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  )
}
