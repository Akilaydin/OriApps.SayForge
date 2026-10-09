import * as bridge from './bridge'
import { t } from '@/i18n'

declare const __SAYFORGE_DEFAULT_SERVER_URL__: string

const BUILTIN_DEFAULT_SERVER_URL =
  typeof __SAYFORGE_DEFAULT_SERVER_URL__ === 'string' && __SAYFORGE_DEFAULT_SERVER_URL__.trim()
    ? __SAYFORGE_DEFAULT_SERVER_URL__.trim()
    : 'http://127.0.0.1:8000'

const BACKEND_BASE_URL_STORE_KEY = 'backendBaseUrl'

interface RuntimeEnv {
  VITE_BACKEND_BASE_URL?: string
  VITE_WS_URL?: string
  DEV?: boolean
}

function getEnv(): RuntimeEnv {
  return (import.meta as unknown as { env?: RuntimeEnv }).env || {}
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeUrl(value: string | null | undefined): string {
  return trimSlash(String(value || '').trim())
}

function resolveBuiltinDefaultBaseUrl(): string {
  const env = getEnv()
  const value = normalizeUrl(env.VITE_BACKEND_BASE_URL)
  if (value) return value
  return trimSlash(BUILTIN_DEFAULT_SERVER_URL)
}

function resolveEnvOverrideBaseUrl(): string {
  const env = getEnv()
  return normalizeUrl(env.VITE_BACKEND_BASE_URL)
}

let backendBaseUrl = resolveBuiltinDefaultBaseUrl()

export async function initRuntimeConfig(): Promise<void> {
  const stored = await bridge.storeGet(BACKEND_BASE_URL_STORE_KEY)
  const normalized = normalizeUrl(typeof stored === 'string' ? stored : '')
  if (normalized) {
    backendBaseUrl = normalized
    return
  }
  const envOverride = resolveEnvOverrideBaseUrl()
  if (envOverride) {
    backendBaseUrl = envOverride
    return
  }
  backendBaseUrl = resolveBuiltinDefaultBaseUrl()
}

export function getDefaultBackendBaseUrl(): string {
  return resolveBuiltinDefaultBaseUrl()
}

export function getBackendBaseUrl(): string {
  return backendBaseUrl
}

export function getUpdateBaseUrl(): string {
  return getBackendBaseUrl()
}

export function getOfficialUpdateBaseUrl(): string {
  return resolveBuiltinDefaultBaseUrl()
}

export function isOfficialUpdateChannel(): boolean {
  return normalizeUrl(getUpdateBaseUrl()) === normalizeUrl(getOfficialUpdateBaseUrl())
}

export async function setBackendBaseUrl(value: string): Promise<string> {
  const normalized = normalizeUrl(value)
  if (!normalized) {
    throw new Error(t('runtimeConfig.emptyServerUrl'))
  }
  backendBaseUrl = normalized
  await bridge.storeSet(BACKEND_BASE_URL_STORE_KEY, normalized)
  return backendBaseUrl
}

export async function resetBackendBaseUrl(): Promise<string> {
  backendBaseUrl = resolveBuiltinDefaultBaseUrl()
  await bridge.storeDelete(BACKEND_BASE_URL_STORE_KEY)
  return backendBaseUrl
}

export async function getStoredBackendBaseUrl(): Promise<string> {
  const stored = await bridge.storeGet(BACKEND_BASE_URL_STORE_KEY)
  return normalizeUrl(typeof stored === 'string' ? stored : '')
}

export function getWSUrl(): string {
  const env = getEnv()
  const explicit = normalizeUrl(env.VITE_WS_URL)
  if (explicit) return explicit

  const base = getBackendBaseUrl()
  if (base.startsWith('https://')) return `${base.replace(/^https:\/\//, 'wss://')}/ws/transcribe`
  if (base.startsWith('http://')) return `${base.replace(/^http:\/\//, 'ws://')}/ws/transcribe`
  return `${resolveBuiltinDefaultBaseUrl().replace(/^https?:\/\//, 'wss://')}/ws/transcribe`
}
