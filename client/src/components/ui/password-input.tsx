//

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'

interface PasswordInputProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  placeholder?: string
  className?: string
}

export function PasswordInput({
  id,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  className,
}: PasswordInputProps) {
  const t = useT()
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onSubmit) onSubmit() }}
        placeholder={placeholder}
        className={cn(className, 'pr-9')}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        aria-label={t(visible ? 'ui.hidePassword' : 'ui.showPassword', { label })}
        aria-pressed={visible}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </div>
  )
}
