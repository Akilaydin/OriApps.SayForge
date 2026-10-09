/**
 * Renderer-side service for saving and loading audio files via IPC.
 */

import * as bridge from './bridge'
import { uint8ArrayToBase64 } from '@/lib/encoding'

export async function saveRecordingAudio(
  id: string,
  chunks: ArrayBuffer[],
  sampleRate = 16000,
): Promise<string | null> {
  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  if (totalLen <= 0) return null

  const expectedBytesPerSec = sampleRate * 2
  const durationSec = totalLen / expectedBytesPerSec
  if (durationSec > 600) {
    console.warn('[audio] saveRecordingAudio: unusually long audio', {
      totalLen,
      durationSec: durationSec.toFixed(1),
      sampleRate,
      chunkCount: chunks.length,
    })
  }

  const merged = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }

  const pcmBase64 = uint8ArrayToBase64(merged)

  return bridge.savePcmAsWav(id, pcmBase64, sampleRate)
}

/**
 * Load audio file as a data URL for playback.
 */
export async function loadAudioAsDataUrl(filePath: string): Promise<string | null> {
  const base64 = await bridge.readAudioFile(filePath)
  if (!base64) return null
  return `data:audio/wav;base64,${base64}`
}

/**
 * Delete an audio file.
 */
export async function deleteAudioFileFromRenderer(filePath: string): Promise<boolean> {
  return bridge.deleteAudioFile(filePath).then(() => true)
}
