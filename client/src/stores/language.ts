/** English-only UI. Model recognition languages remain configurable separately. */
import { getSetting, setSetting } from '@/services/store'
import { setLocale } from '@/i18n'

const LANGUAGE_SETTING_KEY = 'ui.language'

export async function initLanguage(): Promise<void> {
  setLocale('en')
  const saved = await getSetting(LANGUAGE_SETTING_KEY, 'en').catch(() => 'en')
  if (saved !== 'en') await setSetting(LANGUAGE_SETTING_KEY, 'en').catch(() => {})
}
