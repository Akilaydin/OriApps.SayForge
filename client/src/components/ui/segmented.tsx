//
//

import { cn } from '@/lib/utils'

export interface SegmentedOption<T> {
  value: T
  label: string
  disabled?: boolean
}

interface SegmentedProps<T> {
  label?: string
  labelledBy?: string
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Whether option color changes should animate. */
  animated?: boolean
  className?: string
}

export function Segmented<T extends string | number>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  size = 'md',
  disabled,
  animated = true,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center justify-center rounded-lg font-medium outline-none disabled:pointer-events-none disabled:opacity-50',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              animated && 'transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              isActive
                ? 'bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.13]'
                : 'bg-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
