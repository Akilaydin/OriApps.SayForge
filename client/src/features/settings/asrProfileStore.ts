//
//
//

import { getSetting, setSetting } from '@/services/store'
import { addRuntimeEvent } from '@/services/debugLog'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrCardIdOfLegacyProvider,
  asrEndpointUrl,
  asrModelsOf,
  effectiveAsrCredentials,
  emptyAsrProfile,
  parseAsrProfilesDetailed,
  resolveActiveAsrProfile,
  resolveAsrApiModel,
  resolveAsrModelOption,
  resolveAsrRuntimeProvider,
  type AsrPlatform,
  type AsrProfile,
} from './asrProviderCatalog'

export const ASR_PROFILES_KEY = 'cloudAsr.profiles'
export const ASR_ACTIVE_PROFILE_KEY = 'cloudAsr.activeProfileId'
export const ASR_AUTO_CREATED_KEY = 'cloudAsr.autoCreatedProviders'

export interface AsrProfileState {
  profiles: AsrProfile[]
  activeId: string
}

let orphanProfiles: unknown[] = []

async function syncRuntimeActive(profile: AsrProfile | null): Promise<void> {
  const creds = profile ? effectiveAsrCredentials(profile) : { apiKey: '', appId: '' }
  await Promise.all([
    setSetting('cloudAsr.provider', profile ? resolveAsrRuntimeProvider(profile) : ''),
    setSetting('cloudAsr.model', profile ? resolveAsrApiModel(profile) : ''),
    setSetting('cloudAsr.apiKey', creds.apiKey),
    setSetting('cloudAsr.appId', creds.appId),
    setSetting('cloudAsr.systemInstruction', profile?.provider === 'openai_compat' ? profile.systemInstruction : ''),
    setSetting('cloudAsr.userPrompt', profile?.provider === 'openai_compat' ? profile.userPrompt : ''),
    setSetting('cloudAsr.audioEncoding', profile?.provider === 'openai_compat' ? profile.audioEncoding : 'wav'),
    setSetting('cloudAsr.baseUrl', profile ? asrEndpointUrl(profile) : ''),
    setSetting('cloudAsr.protocol', profile?.protocol ?? 'auto'),
  ])
}

interface PlatformCreds {
  apiKey: string
  otherKey: string
  appId: string
  console: 'new' | 'legacy'
  workspaceId: string
  omniPrompt: string
}

async function readPlatformCreds(platform: AsrPlatform): Promise<PlatformCreds> {
  return {
    apiKey: await getSetting(`cloudAsr.${platform}.apiKey`, '') as string,
    otherKey: '',
    appId: '',
    console: 'new',
    workspaceId: '',
    omniPrompt: '',
  }
}

function hasKey(creds: PlatformCreds): boolean {
  return creds.apiKey.trim() !== '' || creds.otherKey.trim() !== ''
}

export function topUpProfiles(
  existing: AsrProfile[],
  credsByPlatform: Partial<Record<AsrPlatform, PlatformCreds>>,
  alreadyAuto: string[] = [],
): { profiles: AsrProfile[]; added: string[] } {
  const added: AsrProfile[] = []
  const autoCards = new Set(alreadyAuto.map(asrCardIdOfLegacyProvider))
  for (const entry of ASR_PROVIDERS) {
    const creds = credsByPlatform[entry.platform]
    if (!creds || !hasKey(creds)) continue
    if (existing.some((p) => p.provider === entry.id)) continue
    if (autoCards.has(entry.id)) continue
    const profile = emptyAsrProfile(entry.id)
    // Existing platform credentials came from the legacy WAV-only setup.
    profile.audioEncoding = 'wav'
    profile.apiKey = creds.apiKey
    profile.otherKey = creds.otherKey
    profile.appId = creds.appId
    profile.console = creds.console
    profile.workspaceId = creds.workspaceId
    profile.omniPrompt = asrModelsOf(entry).some((m) => m.omni) ? creds.omniPrompt : ''
    added.push(profile)
  }
  return {
    profiles: [...existing, ...added],
    added: added.map((p) => p.provider),
  }
}

export async function loadAsrProfiles(): Promise<AsrProfileState> {
  const [rawProfiles, storedActiveId, rawAuto] = await Promise.all([
    getSetting(ASR_PROFILES_KEY, [] as unknown[]) as Promise<unknown>,
    getSetting(ASR_ACTIVE_PROFILE_KEY, '') as Promise<string>,
    getSetting(ASR_AUTO_CREATED_KEY, [] as unknown[]) as Promise<unknown>,
  ])

  const parsed = parseAsrProfilesDetailed(rawProfiles)
  orphanProfiles = parsed.orphans
  if (orphanProfiles.length > 0) {
    addRuntimeEvent('warn', 'settings', 'ASR profiles could not be parsed; kept as-is in storage', {
      count: orphanProfiles.length,
    })
  }
  let profiles = parsed.profiles
  let activeId = storedActiveId
  let needsWrite = parsed.profiles.some((profile) => {
    const old = Array.isArray(rawProfiles) ? rawProfiles.find((p) => p?.id === profile.id) : undefined
    return old && (old.provider !== profile.provider || old.model !== profile.model
      || old.apiUrl !== profile.apiUrl || old.protocol !== profile.protocol)
  })
  const alreadyAuto = Array.isArray(rawAuto) ? rawAuto.filter((x): x is string => typeof x === 'string') : []

  if (profiles.length === 0 && orphanProfiles.length === 0) {
    const [provider, model, apiKey, apiUrl, protocol, audioEncoding, systemInstruction, userPrompt] = await Promise.all([
      getSetting('cloudAsr.provider', 'openai_compat'), getSetting('cloudAsr.model', ''),
      getSetting('cloudAsr.apiKey', ''), getSetting('cloudAsr.baseUrl', ''),
      getSetting('cloudAsr.protocol', 'auto'), getSetting('cloudAsr.audioEncoding', 'wav'),
      getSetting('cloudAsr.systemInstruction', ''), getSetting('cloudAsr.userPrompt', ''),
    ])
    if (apiKey || apiUrl) {
      const migrated = parseAsrProfilesDetailed([{
        id: emptyAsrProfile().id, provider, model, apiKey, apiUrl, protocol,
        audioEncoding, systemInstruction, userPrompt,
      }]).profiles[0]
      if (migrated) {
        profiles = [migrated]
        activeId = migrated.id
        needsWrite = true
      }
    }
  }

  const credsByPlatform: Partial<Record<AsrPlatform, PlatformCreds>> = {}
  for (const platform of Object.keys(ASR_PLATFORMS) as AsrPlatform[]) {
    credsByPlatform[platform] = await readPlatformCreds(platform)
  }
  const topUp = topUpProfiles(profiles, credsByPlatform, alreadyAuto)
  if (topUp.added.length > 0) {
    profiles = topUp.profiles
    needsWrite = true
    await setSetting(ASR_AUTO_CREATED_KEY, [...alreadyAuto, ...topUp.added])
  }

  if (!activeId && profiles.length > 0) {
    const legacyProvider = await getSetting('cloudAsr.provider', 'openai_compat') as string
    const card = asrCardIdOfLegacyProvider(legacyProvider)
    activeId = profiles.find((p) => p.provider === card)?.id ?? profiles[0].id
    needsWrite = true
  }

  const active = resolveActiveAsrProfile(profiles, activeId)
  if (active && active.id !== activeId) {
    activeId = active.id
    needsWrite = true
  }
  if (!active && activeId !== '') {
    activeId = ''
    needsWrite = true
  }

  if (needsWrite) await saveAsrProfiles({ profiles, activeId })

  return { profiles, activeId }
}

export async function saveAsrProfiles(state: AsrProfileState): Promise<void> {
  const active = resolveActiveAsrProfile(state.profiles, state.activeId)
  await Promise.all([
    setSetting(ASR_PROFILES_KEY, [...state.profiles, ...orphanProfiles]),
    setSetting(ASR_ACTIVE_PROFILE_KEY, active?.id ?? ''),
  ])
  if (active) await syncRuntimeActive(active)
}
