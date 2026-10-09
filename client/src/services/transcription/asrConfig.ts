import { buildAsrExtra } from '@/lib/asrModels'
import { asrEndpointUrl, effectiveAsrCredentials, parseAsrProfilesDetailed, resolveActiveAsrProfile,
  resolveAsrApiModel, resolveAsrRuntimeProvider, parseAsrCompatProtocol, type AsrProfile } from '@/features/settings/asrProviderCatalog'
import { storeGetSettings } from '../bridge'

export interface AsrProviderConfig {
  provider: string
  api_key: string
  extra?: Record<string, unknown>
}

export function asrConfigFromProfile(profile: AsrProfile): AsrProviderConfig {
  const credentials = effectiveAsrCredentials(profile)
  return {
    provider: resolveAsrRuntimeProvider(profile), api_key: credentials.apiKey,
    extra: buildAsrExtra(profile.provider, {
      model: resolveAsrApiModel(profile), baseUrl: asrEndpointUrl(profile), protocol: profile.protocol,
      instructions: profile.systemInstruction, userPrompt: profile.userPrompt, audioEncoding: profile.audioEncoding,
    }),
  }
}

const keys = ['profiles', 'activeProfileId', 'provider', 'apiKey', 'model', 'baseUrl',
  'protocol', 'systemInstruction', 'userPrompt', 'audioEncoding'].map(key => 'cloudAsr.' + key)

export async function loadAsrConfig(): Promise<AsrProviderConfig> {
  let settings: Record<string, unknown>
  try { settings = await storeGetSettings(keys) }
  catch { throw new Error('Could not read ASR settings') }
  const str = (key: string, fallback = '') => typeof settings['cloudAsr.' + key] === 'string'
    ? settings['cloudAsr.' + key] as string : fallback
  const raw = settings['cloudAsr.profiles']
  const profile = resolveActiveAsrProfile(parseAsrProfilesDetailed(raw).profiles, str('activeProfileId'))
  if (profile) return asrConfigFromProfile(profile)
  if (Array.isArray(raw) && raw.length) throw new Error('No compatible ASR profile configured')
  const provider = str('provider', 'openai_compat')
  return {
    provider, api_key: str('apiKey'),
    extra: buildAsrExtra(provider, {
      model: str('model'), baseUrl: str('baseUrl'), protocol: parseAsrCompatProtocol(str('protocol')),
      instructions: str('systemInstruction'), userPrompt: str('userPrompt'), audioEncoding: str('audioEncoding', 'wav'),
    }),
  }
}
