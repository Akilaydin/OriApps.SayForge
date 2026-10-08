import { useEffect, useSyncExternalStore } from 'react'
import { NavLink } from 'react-router-dom'
import { Home, Clock, BookOpen, Settings, Info, Cpu, Cloud, AudioLines, Sparkles, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'
import { hasPendingUpdate } from '@/features/update/autoUpdate'
import { useUpdateState } from '@/features/update/useUpdateState'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

// 导航项存 key 而不是文案：切语言时这些常量不会重新求值（模块级只算一次），
// 存成中文串就会永远停在启动时那个语言。
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
  /** 覆盖图标自身的颜色/动效（如「有更新」时的绿色闪烁） */
  iconClassName?: string
}) {
  return (
    <Tooltip content={label}>
      <NavLink
        to={to}
        // 这里只有图标、没有文字，不给 aria-label 的话读屏用户听到的是空按钮
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

/**
 * 侧栏底部那排图标。
 *
 * 有更新待安装时**不新增图标** —— 让「关于」这一枚自己变绿闪烁，悬停提示换成
 * 「新版本已下载好」。关于页就是更新所在的地方，点它正好到达能看到版本说明和
 * 「立即安装」的位置；多一枚图标既挤又需要用户先学会它是什么意思。
 *
 * 后台下载期间**故意毫无变化**：那会儿没有任何需要用户知道的事，静默才是本意。
 *
 * ⚠ 这里用绿色不违反下面 ModeIndicator 那条"不给任何好颜色"的规矩：那条针对的是
 * 我们没验证过的事（配置填完了 ≠ 真能用）。而"包已下载完、哈希校验过、随时可装"
 * 是确定的事实。别顺手把它改回中性色。
 */
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

/** Local and cloud voice engine readiness, without server connection state. */
function ModeIndicator() {
  const t = useT()
  const { mode, detail, ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  useEffect(() => { void refreshModeStatus() }, [])

  const Icon = mode === 'local' ? Cpu : Cloud
  const title = mode === 'local' ? t('mode.local') : t('mode.cloudApi')
  const notReady = ready === false
  // blockedReason 目前是 Rust/服务层给的中文串（P2-1 会改成 code 再本地化）。
  // 这里只保证**外壳**跟随语言，不假装里面那句已经翻好了。
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
