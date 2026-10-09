
export const DEFAULTS: Record<string, unknown> = {

  'ui.language': 'en',

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
  'ai.builtinPromptLanguage': 'en',

  'cloudAi.provider': 'openai_compat',
  'cloudAi.apiUrl': '',
  'cloudAi.apiKey': '',
  'cloudAi.model': '',
  'cloudAi.profiles': [],
  'cloudAi.activeProfileId': '',
  'cloudAi.profilesMigrated': false,

  // 'doubao_v2' | 'qwen' | 'qwen_audio_stream' | 'qwen_realtime' | 'qwen_omni_35_*'
  // | 'mimo' | 'groq_whisper' | 'openai_transcribe' | 'openai_live_transcribe'
  // | 'gemini_transcribe' | 'gemini_live_transcribe' | 'openrouter_transcribe'
  'cloudAsr.provider': 'openai_compat',
  'cloudAsr.model': '',
  'cloudAsr.apiKey': '',
  'cloudAsr.appId': '',
  'cloudAsr.profiles': [],
  'cloudAsr.activeProfileId': '',
  'cloudAsr.autoCreatedProviders': [],



  overlayWaveTheme: 'black-rainbow',
  overlayShowDuration: true,
  overlayWidth: 'short',

  streamingDisplayEnabled: false,

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
