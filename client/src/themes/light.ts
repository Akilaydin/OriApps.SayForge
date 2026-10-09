import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

const light: ThemeDefinition = {
  id: 'light',
  get name() { return t('theme.light') },
  isDark: false,
  previewColors: {
    bg: '#ffffff',
    sidebar: '#ffffff',
    primary: '#18181b',
    accent: '#f4f4f5',
  },
  vars: {
    '--background': '0 0% 100%',
    '--foreground': '240 10% 3.9%',
    '--card': '0 0% 100%',
    '--card-foreground': '240 10% 3.9%',
    '--primary': '240 5.9% 10%',
    '--primary-foreground': '0 0% 98%',
    '--secondary': '240 4.8% 95.9%',
    '--secondary-foreground': '240 5.9% 10%',
    '--muted': '240 4.8% 95.9%',
    '--muted-foreground': '240 3.8% 46.1%',
    '--accent': '240 4.8% 95.9%',
    '--accent-foreground': '240 5.9% 10%',
    '--destructive': '0 84.2% 60.2%',
    '--destructive-foreground': '0 0% 98%',
    '--destructive-strong': '0 74% 46%',
    '--border': '240 5.9% 90%',
    '--input': '240 5.9% 90%',
    '--ring': '240 5.9% 10%',
    '--radius': '0.5rem',

    '--sidebar-bg': '0 0% 100%',
    '--sidebar-border': '240 5.9% 90%',
    '--sidebar-item-active-bg': '240 4.8% 95.9%',
    '--sidebar-item-hover-bg': '240 4.8% 97.9%',
    '--sidebar-text': '240 4% 46%',
    '--sidebar-text-active': '240 10% 3.9%',
    '--titlebar-bg': '0 0% 100%',
    '--titlebar-text': '240 4% 46%',
    '--titlebar-close-hover-bg': '0 84.2% 60.2%',
    '--titlebar-close-hover-text': '0 0% 100%',

    '--input-bg': '0 0% 100%',
    '--input-border': '240 5.9% 90%',
    '--input-focus-border': '240 5.9% 10%',
    '--input-focus-ring': '240 5.9% 10%',
    '--input-placeholder': '240 4% 65%',

    '--success': '142 76% 36%',
    '--success-foreground': '0 0% 100%',
    '--success-strong': '142 72% 29%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '0 0% 100%',
    '--warning-strong': '32 95% 34%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--info-strong': '199 89% 33%',
  },
}

export default light
