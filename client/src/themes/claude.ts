import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

const claude: ThemeDefinition = {
  id: 'claude',
  get name() { return t('theme.warm') },
  isDark: false,
  previewColors: {
    bg: '#faf9f5',
    sidebar: '#eeece7',
    primary: '#b5490f',
    accent: '#eeece7',
  },
  vars: {
    '--background': '40 33% 97%',
    '--foreground': '25 8% 20%',
    '--card': '40 33% 98%',
    '--card-foreground': '25 8% 20%',
    '--primary': '22 85% 38%',
    '--primary-foreground': '40 33% 97%',
    '--secondary': '37 22% 90%',
    '--secondary-foreground': '25 8% 20%',
    '--muted': '37 22% 90%',
    '--muted-foreground': '25 6% 50%',
    '--accent': '37 22% 90%',
    '--accent-foreground': '25 8% 20%',
    '--destructive': '0 72% 51%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '0 74% 44%',
    '--border': '37 18% 84%',
    '--input': '37 18% 84%',
    '--ring': '22 85% 38%',
    '--radius': '0.5rem',

    '--sidebar-bg': '37 22% 92%',
    '--sidebar-border': '37 18% 84%',
    '--sidebar-item-active-bg': '37 22% 86%',
    '--sidebar-item-hover-bg': '37 22% 88%',
    '--sidebar-text': '25 6% 50%',
    '--sidebar-text-active': '25 8% 20%',
    '--titlebar-bg': '37 22% 92%',
    '--titlebar-text': '25 6% 50%',
    '--titlebar-close-hover-bg': '0 72% 51%',
    '--titlebar-close-hover-text': '0 0% 100%',

    '--input-bg': '40 33% 98%',
    '--input-border': '37 18% 84%',
    '--input-focus-border': '22 85% 38%',
    '--input-focus-ring': '22 85% 38%',
    '--input-placeholder': '25 6% 62%',

    '--success': '142 76% 36%',
    '--success-foreground': '0 0% 100%',
    '--success-strong': '150 60% 27%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '0 0% 100%',
    '--warning-strong': '26 90% 33%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--info-strong': '203 80% 32%',
  },

  extras: {
    '--claude-accent-warm': '22 85% 38%',
    '--claude-bg-subtle': '40 25% 95%',
  },
}

export default claude
