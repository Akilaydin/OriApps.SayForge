//
//
//

import { getSetting, setSetting } from '@/services/store'
import {
  AI_PROVIDERS,
  aiSettingKey,
  migrateLegacyProfiles,
  parseLegacyLatencies,
  parseProfilesDetailed,
  resolveActiveProfile,
  type AiProfile,
  type LegacyProviderData,
} from './aiProviderCatalog'

export const AI_PROFILES_KEY = 'cloudAi.profiles'
export const AI_ACTIVE_PROFILE_KEY = 'cloudAi.activeProfileId'
export const AI_PROFILES_MIGRATED_KEY = 'cloudAi.profilesMigrated'
export const AI_UNSUPPORTED_RUNTIME_BACKUP_KEY = 'cloudAi.unsupportedRuntimeBackup'

/** Opaque legacy profiles are preserved byte-for-byte across supported profile saves. */
let orphanProfiles: unknown[] = []

export interface AiProfileState {
  profiles: AiProfile[]
  activeId: string
}

async function syncRuntimeActive(profile: AiProfile | null): Promise<void> {
  await Promise.all([
    setSetting('cloudAi.provider', profile?.provider ?? ''),
    setSetting('cloudAi.apiUrl', profile?.apiUrl ?? ''),
    setSetting('cloudAi.apiKey', profile?.apiKey ?? ''),
    setSetting('cloudAi.model', profile?.model ?? ''),
  ])
}

async function readLegacyData(): Promise<LegacyProviderData[]> {
  return Promise.all(
    AI_PROVIDERS.map(async (provider): Promise<LegacyProviderData> => {
      const [apiUrl, apiKey, model, modelsRaw, latencyRaw] = await Promise.all([
        getSetting(aiSettingKey(provider.value, 'apiUrl'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'apiKey'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'model'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'models'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'latency'), '') as Promise<string>,
      ])
      return {
        provider: provider.value,
        apiUrl,
        apiKey,
        model,
        models: modelsRaw ? modelsRaw.split(',').map((m) => m.trim()).filter(Boolean) : [],
        latencies: parseLegacyLatencies(latencyRaw),
      }
    }),
  )
}

export async function loadAiProfiles(): Promise<AiProfileState> {
  const [migrated, rawProfiles, storedActiveId] = await Promise.all([
    getSetting(AI_PROFILES_MIGRATED_KEY, false) as Promise<boolean>,
    getSetting(AI_PROFILES_KEY, [] as unknown[]) as Promise<unknown>,
    getSetting(AI_ACTIVE_PROFILE_KEY, '') as Promise<string>,
  ])

  const parsed = parseProfilesDetailed(rawProfiles)
  orphanProfiles = parsed.orphans
  let profiles = parsed.profiles
  let activeId = storedActiveId
  let needsWrite = false

  if (!migrated) {
    if (profiles.length === 0) {
      const [legacy, legacyProvider, legacyModel] = await Promise.all([
        readLegacyData(),
        getSetting('cloudAi.provider', '') as Promise<string>,
        getSetting('cloudAi.model', '') as Promise<string>,
      ])
      const result = migrateLegacyProfiles(legacy, legacyProvider, legacyModel)
      profiles = result.profiles
      activeId = result.activeId
    }
    await setSetting(AI_PROFILES_MIGRATED_KEY, true)
    needsWrite = profiles.length > 0 || orphanProfiles.length > 0
  }

  const active = resolveActiveProfile(profiles, activeId)
  if (active && active.id !== activeId) {
    activeId = active.id
    needsWrite = true
  }
  if (!active && activeId !== '') {
    activeId = ''
    needsWrite = true
  }

  // A removed vendor may still be in the flat runtime mirror even after the
  // list has been updated. Backup its credentials before selecting a supported
  // profile (or clearing the mirror). Never put secrets in logs.
  const runtimeProvider = await getSetting('cloudAi.provider', '') as string
  if (runtimeProvider && !AI_PROVIDERS.some((p) => p.value === runtimeProvider)) {
    const existingBackup = await getSetting(AI_UNSUPPORTED_RUNTIME_BACKUP_KEY, null)
    if (existingBackup === null || existingBackup === undefined) {
      const [apiUrl, apiKey, model] = await Promise.all([
        getSetting('cloudAi.apiUrl', ''),
        getSetting('cloudAi.apiKey', ''),
        getSetting('cloudAi.model', ''),
      ])
      await setSetting(AI_UNSUPPORTED_RUNTIME_BACKUP_KEY, {
        provider: runtimeProvider, apiUrl, apiKey, model,
      })
    }
    needsWrite = true
  }

  if (needsWrite) {
    await saveAiProfiles({ profiles, activeId })
  }

  return { profiles, activeId }
}

export async function saveAiProfiles(state: AiProfileState): Promise<void> {
  const active = resolveActiveProfile(state.profiles, state.activeId)
  await Promise.all([
    setSetting(AI_PROFILES_KEY, [...state.profiles, ...orphanProfiles]),
    setSetting(AI_ACTIVE_PROFILE_KEY, active?.id ?? ''),
  ])
  await syncRuntimeActive(active)
}
