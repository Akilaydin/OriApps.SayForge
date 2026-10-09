
export const DEFAULTS: Record<string, unknown> = {

  'ui.language': 'en',

  workMode: 'cloud_api', // Supported modes: cloud_api | local

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

  // | 'funasr-nano-2512-gguf' | 'qwen3-asr-0.6b-gguf'
  'localAsr.modelId': 'nemotron-asr-streaming-0.6b-gguf',
  'localAsr.language': 'auto',
  'localAsr.downloadSource': 'HuggingFace',
  'localAsr.model': '',
  'localAsr.accelerator': 'auto',
  'localAsr.gpuDevice': '',
  'localAsr.unloadIdleMinutes': 0,


  overlayWaveTheme: 'black-rainbow',
  overlayShowDuration: true,
  overlayWidth: 'short',

  streamingDisplayEnabled: false,

  injectHotwordsToPrompt: false,

  readySoundEnabled: true,

  historyEnabled: true,
  audioRetentionEnabled: true,
  audioRetentionDays: -1,
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
