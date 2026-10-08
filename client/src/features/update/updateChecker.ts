
import { getOfficialUpdateBaseUrl, getUpdateBaseUrl, isOfficialUpdateChannel } from '@/services/runtimeConfig'

export interface VersionInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  releaseDate: string | null
  sha512: string | null
  error: string | null
  sourceUrl: string | null
}

export function compareVersions(current: string, latest: string): number {
  const parse = (value: string) => value.split('.').map((segment) => {
    const parsed = Number.parseInt(segment, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const a = parse(current)
  const b = parse(latest)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] || 0) - (a[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function checkVersionUpdate(currentVersion: string): Promise<VersionInfo> {
  const configured = await fetchManifest(currentVersion, getUpdateBaseUrl())
  if (configured.latestVersion || isOfficialUpdateChannel()) return configured

  const fallback = await fetchManifest(currentVersion, getOfficialUpdateBaseUrl())
  return fallback.latestVersion ? fallback : configured
}

async function fetchManifest(currentVersion: string, baseUrl: string): Promise<VersionInfo> {
  const base: VersionInfo = {
    hasUpdate: false,
    currentVersion,
    latestVersion: null,
    downloadUrl: null,
    releaseDate: null,
    sha512: null,
    error: null,
    sourceUrl: baseUrl,
  }

  try {
    const resp = await fetch(`${baseUrl}/api/desktop-updates/win32/x64/manifest`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      base.error = resp.status === 404 ? null : `HTTP ${resp.status}`
      return base
    }
    const manifest = await resp.json() as {
      version?: string
      releaseDate?: string
      download_path?: string
      sha512?: string
    }
    const latestVersion = manifest.version
    if (!latestVersion) return base

    base.latestVersion = latestVersion
    base.releaseDate = manifest.releaseDate || null
    base.sha512 = manifest.sha512 || null
    base.downloadUrl = manifest.download_path
      ? `${baseUrl}${manifest.download_path}`
      : null
    base.hasUpdate = compareVersions(currentVersion, latestVersion) > 0
    return base
  } catch (err) {
    base.error = String(err)
    return base
  }
}
