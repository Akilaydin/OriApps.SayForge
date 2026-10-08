import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

const teal: ThemeDefinition = {
  id: 'teal',
  get name() { return t('theme.teal') },
  isDark: false,
  previewColors: {
    bg: '#f5f3eb',
    sidebar: '#edeae2',
    primary: '#0d7377',
    accent: '#e8eeec',
  },
  vars: {
    '--background': '42 22% 94%',          // #f5f3eb
    '--foreground': '220 13% 18%',         // #1f2937
    '--card': '44 50% 97%',
    '--card-foreground': '220 13% 18%',
    '--primary': '182 80% 26%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '40 16% 90%',           // #ece9e1
    '--secondary-foreground': '220 13% 18%',
    '--muted': '40 16% 90%',
    '--muted-foreground': '220 9% 46%',
    '--accent': '175 14% 91%',
    '--accent-foreground': '220 13% 18%',
    '--destructive': '0 72% 51%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '0 74% 44%',
    '--border': '36 22% 85%',
    '--input': '36 22% 85%',
    '--ring': '182 80% 26%',
    '--radius': '0.5rem',

    '--sidebar-bg': '40 16% 90%',
    '--sidebar-border': '36 22% 85%',
    '--sidebar-item-active-bg': '175 16% 87%',
    '--sidebar-item-hover-bg': '40 14% 88%',
    '--sidebar-text': '220 9% 46%',
    '--sidebar-text-active': '182 80% 26%',
    '--titlebar-bg': '40 16% 90%',
    '--titlebar-text': '220 9% 46%',
    '--titlebar-close-hover-bg': '0 72% 51%',
    '--titlebar-close-hover-text': '0 0% 100%',

    '--input-bg': '44 50% 97%',
    '--input-border': '36 22% 85%',
    '--input-focus-border': '182 80% 26%',
    '--input-focus-ring': '182 80% 26%',
    '--input-placeholder': '220 6% 58%',

    '--success': '160 60% 38%',
    '--success-foreground': '0 0% 100%',
    '--success-strong': '162 60% 27%',
    '--warning': '38 85% 50%',
    '--warning-foreground': '0 0% 100%',
    '--warning-strong': '32 90% 33%',
    '--info': '195 80% 44%',
    '--info-foreground': '0 0% 100%',
    '--info-strong': '197 80% 30%',
  },
}

export default teal
