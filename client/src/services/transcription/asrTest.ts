import { invoke } from '@tauri-apps/api/core'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import type { AsrProviderConfig } from './asrConfig'

export interface TestAudio { pcmB64: string; audioSec: number }

export function parseTestWav(bytes: Uint8Array): TestAudio {
  const invalid = () => new Error('Test audio must be nonempty 16 kHz mono PCM16 WAV')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw invalid()
  const end = view.getUint32(4, true) + 8
  if (end > bytes.length || end < 12) throw invalid()
  let formatOk = false
  let pcm: Uint8Array | undefined
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw invalid()
    const size = view.getUint32(offset + 4, true), start = offset + 8
    if (start + size > end) throw invalid()
    if (tag(offset) === 'fmt ') {
      formatOk = size >= 16 && view.getUint16(start, true) === 1
        && view.getUint16(start + 2, true) === 1 && view.getUint32(start + 4, true) === 16000
        && view.getUint32(start + 8, true) === 32000 && view.getUint16(start + 12, true) === 2
        && view.getUint16(start + 14, true) === 16
    } else if (tag(offset) === 'data') pcm = bytes.subarray(start, start + size)
    offset = start + size + (size % 2)
    if (offset > end) throw invalid()
  }
  if (!formatOk || !pcm?.length || pcm.length % 2) throw invalid()
  return { pcmB64: uint8ArrayToBase64(pcm), audioSec: pcm.length / 32000 }
}

export async function prepareTestPcm(): Promise<TestAudio> {
  const wav = await invoke<string>('get_test_audio_b64')
  return parseTestWav(Uint8Array.from(atob(wav), char => char.charCodeAt(0)))
}

export async function testCloudAsr(config: AsrProviderConfig, audio: TestAudio) {
  const start = performance.now()
  const result = await invoke<{text: string; elapsed_ms: number}>('cloud_transcribe', {
    request: {audio_b64: audio.pcmB64, sample_rate: 16000, asr_config: config},
  })
  return {text: result.text.trim(), latencyMs: Math.round(performance.now() - start), audioSec: audio.audioSec}
}
