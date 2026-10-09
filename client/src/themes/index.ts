import type { ThemeDefinition, ThemeId } from './types'
import light from './light'
import dark from './dark'
import claude from './claude'

const themes: Record<string, ThemeDefinition> = {
  light,
  dark,
  claude,
}

export const themeList: ThemeDefinition[] = Object.values(themes)

export function getTheme(id: string): ThemeDefinition {
  return Object.prototype.hasOwnProperty.call(themes, id) ? themes[id] : themes.light
}

let currentThemeId: string = 'light'

export function getCurrentThemeId(): string {
  return currentThemeId
}

const DEFAULT_FONT_BODY = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'

export function applyTheme(id: string): string {
  const theme = getTheme(id)
  const root = document.documentElement

  const allVars = { ...theme.vars, ...(theme.extras || {}) }
  for (const [key, value] of Object.entries(allVars)) {
    root.style.setProperty(key, value)
  }

  document.body.style.fontFamily = theme.fonts?.body || DEFAULT_FONT_BODY

  if (theme.isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }

  for (const t of themeList) {
    root.classList.remove(`theme-${t.id}`)
  }
  root.classList.add(`theme-${theme.id}`)

  currentThemeId = theme.id
  return theme.id
}

export type { ThemeDefinition, ThemeId }
