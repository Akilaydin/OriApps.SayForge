
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAiEnabled } from '@/hooks/useAiEnabled'
import { toggleAiEnabled } from '@/stores/aiEnabled'
import { useT } from '@/i18n/useT'
import { ComboShortcutInput } from './ShortcutInputs'
import { useEffect, useState } from 'react'
import { getSetting, setSetting } from '@/services/store'
import { refreshRecorderSettings } from '@/services/recorder'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'
import * as bridge from '@/services/bridge'
import { MAX_RECORDING_SEC } from '@/services/recorder/types'

export default function AIProofreadToggle() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  const [shortcut, setShortcut] = useState('')
  const [minDurationSec, setMinDurationSec] = useState(0)

  useEffect(() => {
    void Promise.all([
      getSetting('shortcutToggleAi', ''),
      getSetting('aiMinDurationSec', 0),
    ]).then(([savedShortcut, savedMinDuration]) => {
      setShortcut(String(savedShortcut || ''))
      setMinDurationSec(Math.max(0, Math.min(MAX_RECORDING_SEC, Number(savedMinDuration) || 0)))
    })
  }, [])

  const validateShortcut = async (value: string) => {
    const [ptt, handsFree] = await Promise.all([
      getSetting<string>('shortcutPTT', 'ControlRight'),
      getSetting<string>('shortcutHandsFree', 'AltRight'),
    ])
    if (pttShortcutConflictsWithAccelerator(ptt, value)) return t('aiProofread.shortcutConflictPtt')
    if (handsFree === value) return t('aiProofread.shortcutConflictHandsFree')
    return null
  }

  const saveShortcut = async (value: string) => {
    setShortcut(value)
    await setSetting('shortcutToggleAi', value)
    bridge.notifyShortcutsChanged()
  }

  const saveMinDuration = async (next: number) => {
    setMinDurationSec(next)
    await setSetting('aiMinDurationSec', next)
    await refreshRecorderSettings()
  }

  const handleMinDurationChange = (value: string, input: HTMLInputElement) => {
    const next = value === '' ? 0 : Math.max(0, Math.min(MAX_RECORDING_SEC, Math.round(Number(value) || 0)))
    input.value = String(next)
    void saveMinDuration(next)
  }

  const minDurationEffect = minDurationSec === 0
    ? t('aiProofread.minDurationDefaultHint')
    : t('aiProofread.minDurationActiveHint', { seconds: minDurationSec })
  const effectToneClass = minDurationSec === 0
    ? 'bg-muted text-muted-foreground'
    : 'bg-primary/10 text-primary'

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 id="ai-proofread-heading" className="text-lg font-semibold">{t('titleBar.aiCleanup')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {aiEnabled ? t('aiProofread.onDesc') : t('aiProofread.offDesc')}
            </p>
          </div>
          <Switch
            checked={aiEnabled}
            onChange={() => { void toggleAiEnabled() }}
            labelledBy="ai-proofread-heading"
            className="shrink-0"
          />
        </div>
        <div className="mt-5 space-y-4">
          <ComboShortcutInput
            value={shortcut}
            onChange={saveShortcut}
            validate={validateShortcut}
            comboOnly
            allowMouseShortcut
            label={t('aiProofread.shortcutLabel')}
            description={t('aiProofread.shortcutDesc')}
          />
          <div>
            <div className="flex items-center justify-between gap-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p
                    id="ai-min-duration-label"
                    className={`text-sm font-medium ${aiEnabled ? '' : 'text-muted-foreground'}`}
                  >
                    {t('aiProofread.minDurationLabel')}
                  </p>
                  {aiEnabled && (
                    <span
                      id="ai-min-duration-effect"
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${effectToneClass}`}
                    >
                      {minDurationEffect}
                    </span>
                  )}
                </div>
                <p id="ai-min-duration-desc" className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {aiEnabled ? t('aiProofread.minDurationDesc') : t('aiProofread.minDurationDisabled')}
                </p>
              </div>
              <label className="mr-2 flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  max={MAX_RECORDING_SEC}
                  step="1"
                  value={minDurationSec}
                  disabled={!aiEnabled}
                  placeholder={t('aiProofread.minDurationOff')}
                  onChange={(event) => handleMinDurationChange(event.target.value, event.currentTarget)}
                  className="h-8 w-16 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-labelledby="ai-min-duration-label"
                  aria-describedby={aiEnabled ? 'ai-min-duration-effect ai-min-duration-desc' : 'ai-min-duration-desc'}
                />
                <span className={`text-sm ${aiEnabled ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                  {t('aiProofread.seconds')}
                </span>
              </label>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
