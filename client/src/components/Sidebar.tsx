import { useEffect, useSyncExternalStore } from 'react'
import { NavLink } from 'react-router-dom'
import { Home, Clock, BookOpen, Settings, Info, Wifi, WifiOff, Cpu, Cloud, AudioLines, Sparkles, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'
import { hasPendingUpdate } from '@/features/update/autoUpdate'
import { useUpdateState } from '@/features/update/useUpdateState'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const dailyNavItems = [
  { to: '/', icon: Home, labelKey: 'nav.home' },
  { to: '/history', icon: Clock, labelKey: 'nav.history' },
] as const satisfies readonly NavItemDef[]

const configNavItems = [
  { to: '/voice-engine', icon: AudioLines, labelKey: 'nav.voiceEngine' },
  { to: '/hotwords', icon: BookOpen, labelKey: 'nav.hotwords' },
  { to: '/ai-instructions', icon: Wand2, labelKey: 'nav.aiInstructions' },
  { to: '/ai-service', icon: Sparkles, labelKey: 'nav.aiService' },
] as const satisfies readonly NavItemDef[]

const footerNavItems = [
  { to: '/settings', icon: Settings, labelKey: 'nav.settings' },
  { to: '/about', icon: Info, labelKey: 'nav.about' },
] as const satisfies readonly NavItemDef[]

interface NavItemDef {
  to: string
  icon: typeof Home
  labelKey: TranslationKey
}

function NavItem({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Home
  label: string
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive ? 'bg-sidebar-item-active font-medium text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  )
}

function IconOnlyNavItem({
  to,
  icon: Icon,
  label,
  iconClassName,
}: {
  to: string
  icon: typeof Home
  label: string
  iconClassName?: string
}) {
  return (
    <Tooltip content={label}>
      <NavLink
        to={to}
        aria-label={label}
        className={({ isActive }) =>
          cn(
            'flex items-center justify-center rounded-lg p-2 transition-colors',
            isActive ? 'bg-sidebar-item-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
          )
        }
      >
        <Icon className={cn('h-4 w-4', iconClassName)} aria-hidden />
      </NavLink>
    </Tooltip>
  )
}

function FooterIcons() {
  const t = useT()
  const update = useUpdateState()
  const updateReady = hasPendingUpdate(update)
  const nextVersion = update.pending?.version || ''

  return (
    <div className="flex items-center gap-1">
      {footerNavItems.map(({ to, icon, labelKey }) => {
        const highlight = updateReady && to === '/about'
        return (
          <IconOnlyNavItem
            key={to}
            to={to}
            icon={icon}
            label={highlight ? t('update.aboutTooltip', { version: nextVersion }) : t(labelKey)}
            iconClassName={highlight ? 'text-success animate-pulse' : undefined}
          />
        )
      })}
      <ModeIndicator />
    </div>
  )
}

const statusConfig = {
  connected: { icon: Wifi, color: 'text-success', labelKey: 'connection.connected' },
  connecting: { icon: Wifi, color: 'text-warning animate-pulse', labelKey: 'connection.connecting' },
  disconnected: { icon: WifiOff, color: 'text-muted-foreground', labelKey: 'connection.disconnected' },
  error: { icon: WifiOff, color: 'text-destructive', labelKey: 'connection.error' },
} as const satisfies Record<string, { icon: typeof Wifi; color: string; labelKey: TranslationKey }>

function ModeIndicator() {
  const t = useT()
  const status = useConnectionStatus()
  const { mode, detail, ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  useEffect(() => { void refreshModeStatus() }, [])

  if (mode === 'server') {
    const { icon: StatusIcon, color, labelKey } = statusConfig[status]
    return (
      <Tooltip content={t('mode.tooltipDetail', { mode: t('mode.server'), detail: t(labelKey) })}>
        <div className="flex items-center justify-center rounded-lg p-2">
          <StatusIcon className={cn('h-4 w-4', color)} />
        </div>
      </Tooltip>
    )
  }

  const Icon = mode === 'local' ? Cpu : Cloud
  const title = mode === 'local' ? t('mode.local') : t('mode.cloudApi')
  const notReady = ready === false
  const tip = notReady
    ? t('mode.tooltipNotReady', { mode: title, reason: blockedReason || t('mode.notReadyFallback') })
    : detail ? t('mode.tooltipDetail', { mode: title, detail }) : title

  return (
    <Tooltip content={tip}>
      <div className="flex items-center justify-center rounded-lg p-2">
        <Icon className={cn('h-4 w-4', notReady ? 'text-warning' : 'text-sidebar-text')} />
      </div>
    </Tooltip>
  )
}

export default function Sidebar() {
  const t = useT()
  return (
    <nav className="flex w-48 flex-col border-r border-sidebar-border bg-sidebar py-4">
      <div className="flex-1 space-y-1 px-3">
        {dailyNavItems.map(({ to, icon, labelKey }) => (
          <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
        ))}

        <div className="px-1 py-3">
          <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        </div>
        {configNavItems.map(({ to, icon, labelKey }) => (
          <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
        ))}
      </div>

      <div className="space-y-3 px-3 pt-4">
        <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        <FooterIcons />
      </div>
    </nav>
  )
}
