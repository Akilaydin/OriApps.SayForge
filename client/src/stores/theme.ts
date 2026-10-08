import { applyTheme, getCurrentThemeId } from '@/themes'
import { getSetting, setSetting } from '@/services/store'

const THEME_SETTING_KEY = 'theme'
const DEFAULT_THEME = 'teal-dark'

export async function initTheme(): Promise<string> {
  const saved = await getSetting(THEME_SETTING_KEY, DEFAULT_THEME)
  const themeId = typeof saved === 'string' ? saved : DEFAULT_THEME
  return applyTheme(themeId)
}

export async function switchTheme(id: string): Promise<string> {
  const applied = applyTheme(id)
  await setSetting(THEME_SETTING_KEY, applied)
  return applied
}

export function getActiveThemeId(): string {
  return getCurrentThemeId()
}
