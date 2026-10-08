
export interface ThemeVars {
  '--background': string
  '--foreground': string
  '--card': string
  '--card-foreground': string
  '--primary': string
  '--primary-foreground': string
  '--secondary': string
  '--secondary-foreground': string
  '--muted': string
  '--muted-foreground': string
  '--accent': string
  '--accent-foreground': string
  '--destructive': string
  '--destructive-foreground': string
  '--border': string
  '--input': string
  '--ring': string
  '--radius': string

  '--sidebar-bg': string
  '--sidebar-border': string
  '--sidebar-item-active-bg': string
  '--sidebar-item-hover-bg': string
  '--sidebar-text': string
  '--sidebar-text-active': string
  '--titlebar-bg': string
  '--titlebar-text': string
  '--titlebar-close-hover-bg': string
  '--titlebar-close-hover-text': string

  '--input-bg': string
  '--input-border': string
  '--input-focus-border': string
  '--input-focus-ring': string
  '--input-placeholder': string

  //
  //
  '--success': string
  '--success-foreground': string
  '--success-strong': string
  '--warning': string
  '--warning-foreground': string
  '--warning-strong': string
  '--info': string
  '--info-foreground': string
  '--info-strong': string
  '--destructive-strong': string
}

export type ThemeExtras = Record<string, string>

export interface ThemeFonts {
  body?: string
  mono?: string
}

export interface ThemeDefinition {
  id: string
  name: string
  isDark: boolean
  previewColors: {
    bg: string
    sidebar: string
    primary: string
    accent: string
  }
  vars: ThemeVars
  extras?: ThemeExtras
  fonts?: ThemeFonts
}

export type ThemeId = 'light' | 'dark' | 'claude'
