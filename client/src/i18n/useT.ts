import { useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale, t, type Locale } from '.'

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

export function useT(): typeof t {
  useLocale()
  return t
}
