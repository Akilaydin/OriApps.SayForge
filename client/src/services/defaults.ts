import { DEFAULT_MIC_GAIN_DB, DEFAULT_MIC_GAIN_ENABLED } from './micGain'

export const DEFAULTS: Record<string, unknown> = {

  workMode: 'cloud_api',

  shortcutPTT: 'ControlRight',
  shortcutHandsFree: 'AltRight',

  selectedMic: '',
  muteSystemAudioWhileRecording: false,
  micNoiseSuppression: true,
  micGainEnabled: DEFAULT_MIC_GAIN_ENABLED,
  micGainDb: DEFAULT_MIC_GAIN_DB,

  protectClipboard: true,



  'cloudAsr.provider': 'openai_compat',
  'cloudAsr.model': '',
  'cloudAsr.apiKey': '',
  'cloudAsr.profiles': [],
  'cloudAsr.activeProfileId': '',
  'cloudAsr.autoCreatedProviders': [],



  overlayWaveTheme: 'black-rainbow',
  overlayShowDuration: true,
  overlayWidth: 'short',


  readySoundEnabled: true,

  historyEnabled: true,
  logRetentionDays: 30,


  textPostProcess: {
    autoSegment: true,
    stripTrailingPunctuation: false,
    punctuationToSpace: false,
  },

  hotwordLearning: null,

  onboardingVersion: '',

  dismissedNoticeIds: [],
}

export function getDefault<T>(key: string, fallback?: T): T {
  if (key in DEFAULTS) {
    return DEFAULTS[key] as T
  }
  return fallback as T
}
