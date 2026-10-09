import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { MAX_MIC_GAIN_DB, MIN_MIC_GAIN_DB } from '@/services/micGain'
import { buildMicOptions } from './utils'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

export type MicVolumeLevel = 'idle' | 'silent' | 'low' | 'normal'

const VOLUME_CONFIG: Record<MicVolumeLevel, { labelKey: TranslationKey | null; color: string; descKey: TranslationKey | null }> = {
  idle: { labelKey: null, color: '', descKey: null },
  silent: { labelKey: 'mic.level.silent', color: 'text-destructive', descKey: 'mic.level.silentDesc' },
  low: { labelKey: 'mic.level.low', color: 'text-amber-500', descKey: 'mic.level.lowDesc' },
  normal: { labelKey: 'mic.level.normal', color: 'text-emerald-500', descKey: 'mic.level.normalDesc' },
}

export default function MicrophoneSection({
  mics,
  selectedMic,
  gainEnabled,
  gainDb,
  gainReady,
  gainSaving,
  gainSaveError,
  testing,
  volumeLevel,
  errorMessage,
  onCanvasRef,
  onMicChange,
  onTestMic,
  onGainEnabledToggle,
  onGainDbChange,
  onGainDbCommit,
}: {
  mics: MediaDeviceInfo[]
  selectedMic: string
  gainEnabled: boolean
  gainDb: number
  gainReady: boolean
  gainSaving: boolean
  gainSaveError?: string
  testing: boolean
  volumeLevel: MicVolumeLevel
  errorMessage?: string
  onCanvasRef: (node: HTMLCanvasElement | null) => void
  onMicChange: (deviceId: string) => void
  onTestMic: () => void
  onGainEnabledToggle: () => void
  onGainDbChange: (db: number) => void
  onGainDbCommit: (db: number) => void
}) {
  const t = useT()
  const micOptions = useMemo(() => buildMicOptions(mics, selectedMic, {
    systemDefault: t('mic.systemDefault'),
    systemDefaultWith: (deviceName) => t('mic.systemDefaultWith', { device: deviceName }),
    unnamed: (idPrefix) => t('mic.unnamed', { id: idPrefix }),
    unavailable: t('mic.unavailable'),
  }), [mics, selectedMic, t])

  const vol = VOLUME_CONFIG[volumeLevel]

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('mic.title')}</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm text-foreground">{t('mic.select')}</label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedMic}
                onChange={onMicChange}
                options={micOptions}
                className="sm:flex-1"
              />
              <Button variant="outline" size="sm" onClick={onTestMic} disabled={testing || !gainReady} className="h-9 shrink-0 px-4">
                {testing ? t('mic.testing') : t('mic.test')}
              </Button>
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p id="mic-gain-toggle-label" className="text-sm font-medium">{t('mic.gain.title')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('mic.gain.desc')}</p>
              </div>
              <Switch
                checked={gainEnabled}
                onChange={onGainEnabledToggle}
                labelledBy="mic-gain-toggle-label"
                disabled={!gainReady || gainSaving}
                hidden={!gainReady}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4 text-sm">
                <label id="mic-gain-db-label" htmlFor="mic-gain-db">{t('mic.gain.level')}</label>
                <span className="font-medium tabular-nums">+{gainDb} dB</span>
              </div>
              <input
                id="mic-gain-db"
                type="range"
                min={MIN_MIC_GAIN_DB}
                max={MAX_MIC_GAIN_DB}
                step={1}
                value={gainDb}
                disabled={!gainReady || !gainEnabled || gainSaving}
                aria-labelledby="mic-gain-db-label"
                onChange={(event) => onGainDbChange(Number(event.currentTarget.value))}
                onPointerUp={(event) => onGainDbCommit(Number(event.currentTarget.value))}
                onPointerCancel={(event) => onGainDbCommit(Number(event.currentTarget.value))}
                onKeyUp={(event) => onGainDbCommit(Number(event.currentTarget.value))}
                onBlur={(event) => onGainDbCommit(Number(event.currentTarget.value))}
                className="w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0 dB</span>
                <span>+{MAX_MIC_GAIN_DB} dB</span>
              </div>
            </div>
            {gainSaveError && (
              <p role="alert" className="text-xs text-destructive">{gainSaveError}</p>
            )}
          </div>

          {testing && (
            <div className="space-y-2">
              <canvas
                ref={onCanvasRef}
                width={160}
                height={40}
                className="mx-auto rounded-md border border-border"
                style={{ width: '160px', height: '40px' }}
              />
              {volumeLevel !== 'idle' && (
                <div className="text-center">
                  <span className={`text-xs font-medium ${vol.color}`}>{vol.labelKey ? t(vol.labelKey) : ''}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">{vol.descKey ? t(vol.descKey) : ''}</p>
                </div>
              )}
            </div>
          )}

          {errorMessage && !testing && (
            <p className="text-xs text-destructive">{errorMessage}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
