/** English-only UI strings. ASR language selection is independent from UI language. */
import en from './locales/en.json'

export const LOCALES = ['en'] as const
export type Locale = 'en'
export type LanguagePreference = 'auto' | Locale
export type TranslationKey = keyof typeof en

const listeners = new Set<() => void>()

export function isLocale(value: unknown): value is Locale {
  return value === 'en'
}

/** All system and persisted language preferences resolve to English. */
export function resolveLocale(_raw: string | null | undefined): Locale {
  return 'en'
}

/** Keep accepting the old 'auto' preference for stored settings compatibility. */
export function normalizePreference(value: unknown): LanguagePreference {
  return value === 'auto' ? 'auto' : 'en'
}

export function getLocale(): Locale {
  return 'en'
}

export function setLocale(_locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = 'en'
  listeners.forEach((listener) => listener())
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const template: string = en[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
