
import { useEffect, useSyncExternalStore } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'
//
import { Cpu, Cloud, Server, CheckCircle2, type LucideIcon } from 'lucide-react'
import type { WorkMode } from '@/services/transcription'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const modes: Array<{ value: WorkMode; labelKey: TranslationKey; descKey: TranslationKey; privacyKey: TranslationKey; icon: LucideIcon }> = [
  {
    value: 'local', labelKey: 'mode.local',
    descKey: 'workMode.local.desc',
    privacyKey: 'workMode.local.privacy',
    icon: Cpu,
  },
  {
    value: 'cloud_api', labelKey: 'mode.cloudApi',
    descKey: 'workMode.cloudApi.desc',
    privacyKey: 'workMode.cloudApi.privacy',
    icon: Cloud,
  },
  {
    value: 'server', labelKey: 'mode.server',
    descKey: 'workMode.server.desc',
    privacyKey: 'workMode.server.privacy',
    icon: Server,
  },
]

const statusConfig = {
  connected: { dot: 'bg-success', textKey: 'status.connected', bg: 'bg-success/10 text-success-strong' },
  connecting: { dot: 'bg-warning animate-pulse', textKey: 'status.connecting', bg: 'bg-warning/10 text-warning-strong' },
  disconnected: { dot: 'bg-muted-foreground', textKey: 'status.disconnected', bg: 'bg-muted text-muted-foreground' },
  error: { dot: 'bg-destructive', textKey: 'status.error', bg: 'bg-destructive/10 text-destructive-strong' },
} as const satisfies Record<string, { dot: string; textKey: TranslationKey; bg: string }>

interface Props {
  value: WorkMode
  onChange: (mode: WorkMode) => void
}

export default function WorkModeSection({ value, onChange }: Props) {
  const t = useT()
  const wsStatus = useConnectionStatus()
  const { ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  useEffect(() => { void refreshModeStatus() }, [])

  const badge = value === 'server'
    ? { dot: statusConfig[wsStatus].dot, bg: statusConfig[wsStatus].bg, text: t(statusConfig[wsStatus].textKey), hint: '' }
    : ready === false
      ? {
        dot: 'bg-warning',
        text: t('workMode.badge.needsSetup'),
        bg: 'bg-warning/10 text-warning-strong',
        hint: blockedReason ? t('workMode.hintBlocked', { reason: blockedReason }) : t('workMode.hintIncomplete'),
      }
      : ready === true
        ? { dot: 'bg-success', text: t('workMode.badge.ready'), bg: 'bg-success/10 text-success-strong', hint: '' }
        : { dot: 'bg-muted-foreground', text: t('workMode.badge.checking'), bg: 'bg-muted text-muted-foreground', hint: '' }

  const scrollToConfig = () => {
    document.getElementById('engine-config')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const badgeBody = (
    <>
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${badge.dot}`} aria-hidden />
      {badge.text}
    </>
  )
  const badgeClass = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${badge.bg}`

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="work-mode-heading" className="text-lg font-semibold">{t('workMode.title')}</h2>

          {badge.hint ? (
            <Tooltip variant="light" content={t('workMode.tooltipJump', { hint: badge.hint })}>
              <button
                type="button"
                onClick={scrollToConfig}
                className={`${badgeClass} transition-colors hover:bg-warning/20`}
              >
                {badgeBody}
              </button>
            </Tooltip>
          ) : (
            <span className={badgeClass} role="status">{badgeBody}</span>
          )}
        </div>

        <div
          role="radiogroup"
          aria-labelledby="work-mode-heading"
          className="grid gap-3 sm:grid-cols-3"
        >
          {modes.map((m) => {
            const isActive = value === m.value
            const Icon = m.icon
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => onChange(m.value)}
                className={`relative rounded-lg border p-4 text-left transition-colors ${isActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent'
                  }`}
              >
                <Icon
                  className={`absolute right-3 top-3 h-5 w-5 transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
                  aria-hidden
                />
                <div className="flex items-center gap-1.5 pr-7 text-sm font-medium">
                  {isActive && <CheckCircle2 className="h-4 w-4 shrink-0 text-success-strong" aria-hidden />}
                  {t(m.labelKey)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{t(m.descKey)}</div>
                <div className="mt-2 border-t border-border/50 pt-2 text-xs leading-relaxed text-muted-foreground">
                  {t(m.privacyKey)}
                </div>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
