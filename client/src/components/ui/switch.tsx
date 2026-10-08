import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: () => void
  label?: string
  labelledBy?: string
  disabled?: boolean
  className?: string
  size?: 'default' | 'sm'
  noAnimation?: boolean
  hidden?: boolean
}

export function Switch({ checked, onChange, label, labelledBy, disabled, className, size = 'default', noAnimation, hidden }: SwitchProps) {
  const sm = size === 'sm'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? undefined : labelledBy}
      onClick={onChange}
      disabled={disabled}
      style={hidden ? { visibility: 'hidden' } : undefined}
      className={cn('inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50', className)}
    >
      <span
        className={cn(
          'relative shrink-0 rounded-full',
          !noAnimation && 'transition-colors',
          sm ? 'h-4 w-7' : 'h-5 w-9',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 top-0.5 rounded-full bg-card shadow',
            !noAnimation && 'transition-transform',
            sm ? 'h-3 w-3' : 'h-4 w-4',
            checked && (sm ? 'translate-x-3' : 'translate-x-4'),
          )}
        />
      </span>
      {label && <span className="text-sm">{label}</span>}
    </button>
  )
}
