/** English-only UI. Model recognition languages remain configurable separately. */
import { setLocale } from '@/i18n'

export function initLanguage(): void {
  setLocale('en')
}
