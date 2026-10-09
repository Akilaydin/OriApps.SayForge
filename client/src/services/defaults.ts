
export const DEFAULTS: Record<string, unknown> = {

  workMode: 'cloud_api',

  shortcutPTT: 'ControlRight',
  shortcutHandsFree: 'AltRight',
  shortcutToggleAi: '',

  selectedMic: '',
  muteSystemAudioWhileRecording: false,
  micNoiseSuppression: true,

  protectClipboard: true,

  aiEnabled: true,
  aiMinDurationSec: 0,
  contextAwareWritingEnabled: false,
  aiPromptAppend: '',

  'cloudAi.provider': 'openai_compat',
  'cloudAi.apiUrl': '',
  'cloudAi.apiKey': '',
  'cloudAi.model': '',
  'cloudAi.profiles': [],
  'cloudAi.activeProfileId': '',
  'cloudAi.profilesMigrated': false,

  'cloudAsr.provider': 'openai_compat',
  'cloudAsr.model': '',
  'cloudAsr.apiKey': '',
  'cloudAsr.profiles': [],
  'cloudAsr.activeProfileId': '',
  'cloudAsr.autoCreatedProviders': [],



  overlayWaveTheme: 'black-rainbow',
  overlayShowDuration: true,
  overlayWidth: 'short',

  injectHotwordsToPrompt: false,

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
