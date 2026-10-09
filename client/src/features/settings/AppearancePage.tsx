
import { useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { themeList } from '@/themes'
import { switchTheme, getActiveThemeId } from '@/stores/theme'
import { getSetting, setSetting } from '@/services/store'
import { refreshOverlaySettings } from '@/services/recorder'
import { OVERLAY_WIDTH_PRESETS, type OverlayWidthPreset } from '@/services/recorder/types'
import { type OverlayWaveTheme } from './utils'
import { type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const OVERLAY_OPTIONS: Array<{
  theme: OverlayWaveTheme
  labelKey: TranslationKey
  barColors: string[]
}> = [
    { theme: 'black-white', labelKey: 'appearance.wave.blackWhite', barColors: ['#e2e8f0', '#cbd5e1', '#94a3b8'] },
    { theme: 'black-blue', labelKey: 'appearance.wave.blackBlue', barColors: ['#22d3ee', '#3b82f6', '#6366f1'] },
    { theme: 'black-rainbow', labelKey: 'appearance.wave.blackRainbow', barColors: ['#4ade80', '#facc15', '#fb923c', '#f87171'] },
  ]

const WIDTH_OPTIONS: Array<{ value: OverlayWidthPreset; labelKey: TranslationKey }> = [
  { value: 'long', labelKey: 'appearance.width.long' },
  { value: 'medium', labelKey: 'appearance.width.medium' },
  { value: 'short', labelKey: 'appearance.width.short' },
]

function getBarColor(index: number, total: number, theme: OverlayWaveTheme): string {
  const t = index / Math.max(1, total - 1)
  if (theme === 'black-white') return '#f1f5f9'
  if (theme === 'black-rainbow') {
    const hue = 140 - Math.round(t * 110)
    const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
    return `hsl(${hue} 95% ${lightness}%)`
  }
  const hue = 190 + Math.round(t * 30)
  const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
  return `hsl(${hue} 90% ${lightness}%)`
}

function getTimerColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e5e7eb'
  if (theme === 'black-rainbow') return '#fef08a'
  return '#bae6fd'
}



function OverlayPreview({ theme, showDuration, barCount }: { theme: OverlayWaveTheme; showDuration: boolean; barCount: number }) {
  const t = useT()
  const barRefs = useRef<Array<HTMLDivElement | null>>([])

  useEffect(() => {
    const heights = new Array(barCount).fill(3)
    let running = true
    let rafId = 0
    let lastFrame = 0
    const FRAME_INTERVAL = 1000 / 30

    const animate = (now: number) => {
      if (!running) return
      if (now - lastFrame >= FRAME_INTERVAL) {
        lastFrame = now
        for (let i = 0; i < heights.length; i++) {
          const target = 3 + Math.random() * 15
          heights[i] = heights[i] + (target - heights[i]) * 0.15
          const el = barRefs.current[i]
          if (el) {
            const h = Math.min(18, Math.max(3, heights[i]))
            el.style.height = `${h}px`
            el.style.opacity = String(0.7 + (h / 18) * 0.3)
          }
        }
      }
      rafId = requestAnimationFrame(animate)
    }
    rafId = requestAnimationFrame(animate)
    return () => {
      running = false
      cancelAnimationFrame(rafId)
    }
  }, [barCount])

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center rounded-full border border-slate-600 bg-black px-4 py-2 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-[2px]" style={{ height: '20px' }}>
          {Array.from({ length: barCount }, (_, index) => {
            const color = getBarColor(index, barCount, theme)
            return (
              <div
                key={index}
                ref={(el) => { barRefs.current[index] = el }}
                className="w-[2.5px] rounded-full"
                style={{
                  backgroundColor: color,
                  height: '3px',
                  opacity: 0.7,
                  transition: 'height 50ms ease-out, opacity 50ms ease-out',
                }}
              />
            )
          })}
        </div>
        {showDuration && (
          <span
            className="ml-1.5 min-w-[24px] text-right font-mono tabular-nums text-xs"
            style={{ color: getTimerColor(theme) }}
          >
            3.2s
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">{t('appearance.overlayPreview')}</span>
    </div>
  )
}

export default function AppearancePage() {
  const t = useT()
  const [activeTheme, setActiveTheme] = useState(getActiveThemeId)
  const [overlayWaveTheme, setOverlayWaveTheme] = useState<OverlayWaveTheme>('black-rainbow')
  const [overlayShowDuration, setOverlayShowDuration] = useState(true)
  const [overlayWidth, setOverlayWidth] = useState<OverlayWidthPreset>('medium')
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    //
    let cancelled = false
    void (async () => {
      const [showDuration, waveTheme, width] = await Promise.all([
        getSetting('overlayShowDuration', true).catch(() => true),
        getSetting('overlayWaveTheme', 'black-rainbow').catch(() => 'black-rainbow'),
        getSetting('overlayWidth', 'medium').catch(() => 'medium'),
      ])
      if (cancelled) return
      setOverlayShowDuration(Boolean(showDuration))
      const t = waveTheme as OverlayWaveTheme
      if (t === 'black-white' || t === 'black-blue' || t === 'black-rainbow') setOverlayWaveTheme(t)
      const w = width as OverlayWidthPreset
      if (w === 'short' || w === 'medium' || w === 'long') setOverlayWidth(w)
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()
    return () => { cancelled = true }
  }, [])

  const handleThemeChange = async (themeId: string) => {
    await switchTheme(themeId)
    setActiveTheme(themeId)
  }

  const handleOverlayThemeChange = async (theme: OverlayWaveTheme) => {
    setOverlayWaveTheme(theme)
    await setSetting('overlayWaveTheme', theme)
    await refreshOverlaySettings()
  }

  const handleToggleDuration = async () => {
    const next = !overlayShowDuration
    setOverlayShowDuration(next)
    await setSetting('overlayShowDuration', next)
    await refreshOverlaySettings()
  }

  const handleOverlayWidthChange = async (preset: OverlayWidthPreset) => {
    setOverlayWidth(preset)
    await setSetting('overlayWidth', preset)
    await refreshOverlaySettings()
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">{t('appearance.title')}</h1>

      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">{t('appearance.appTheme')}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {themeList.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => void handleThemeChange(theme.id)}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${activeTheme === theme.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent'
                    }`}
                >
                  <div className="flex gap-1">
                    {Object.values(theme.previewColors).map((color, i) => (
                      <span
                        key={i}
                        className="h-5 w-5 rounded-full border border-border/50"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                  <span className="text-sm font-medium">{theme.name}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">{t('appearance.overlayStyle')}</h2>

            <div className="space-y-4" style={ready ? undefined : { visibility: 'hidden' }}>
              <div>
                <p className="mb-2 text-sm text-muted-foreground">{t('appearance.waveTheme')}</p>
                <div className="grid gap-2 sm:grid-cols-3" style={ready ? undefined : { visibility: 'hidden' }}>
                  {OVERLAY_OPTIONS.map((option) => (
                    <button
                      key={option.theme}
                      type="button"
                      onClick={() => void handleOverlayThemeChange(option.theme)}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${animate ? 'transition-colors' : ''} ${overlayWaveTheme === option.theme
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent'
                        }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWaveTheme === option.theme ? 'border-primary' : 'border-muted-foreground/40'}`}>
                          {overlayWaveTheme === option.theme && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span>{t(option.labelKey)}</span>
                      </span>
                      <span className="flex gap-0.5">
                        {option.barColors.map((c, i) => (
                          <span key={i} className="h-3 w-1 rounded-sm" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  <p className="mb-2 text-sm text-muted-foreground">{t('appearance.overlayWidth')}</p>
                  <div className="grid gap-2 sm:grid-cols-3" style={ready ? undefined : { visibility: 'hidden' }}>
                    {WIDTH_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => void handleOverlayWidthChange(option.value)}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${animate ? 'transition-colors' : ''} ${overlayWidth === option.value
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-accent'
                          }`}
                      >
                        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWidth === option.value ? 'border-primary' : 'border-muted-foreground/40'}`}>
                          {overlayWidth === option.value && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span>{t(option.labelKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t('appearance.showDuration')}</p>
                    <p className="text-xs text-muted-foreground">{t('appearance.showDurationDesc')}</p>
                  </div>
                  <Switch checked={overlayShowDuration} onChange={handleToggleDuration} noAnimation={!animate} hidden={!ready} />
                </div>

                <div className="mt-4 flex justify-center">
                  <OverlayPreview theme={overlayWaveTheme} showDuration={overlayShowDuration} barCount={OVERLAY_WIDTH_PRESETS[overlayWidth].barCount} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
