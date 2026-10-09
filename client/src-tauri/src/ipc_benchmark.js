// Task-9 encoder retained here only as a measurement baseline.
function baselineByteLoopBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192)
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j])
  }
  return btoa(binary)
}

addEventListener('DOMContentLoaded', async () => {
  const invoke = (...args) => window.__TAURI_INTERNALS__.invoke(...args)
  const rows = []
  try {
    await invoke('benchmark_receive', new Uint8Array(320))
    for (const seconds of [5, 30, 60, 300]) {
      const raw = new Uint8Array(seconds * 32000)
      for (let i = 0; i < raw.length; i++) raw[i] = i % 251
      const checksum = raw.reduce((sum, value) => sum + value, 0)
      for (const mode of benchmarkModes) {
        for (let trial = 0; trial < 3; trial++) {
          // Existing sendAudio copies each block before stop. Kept in both variants.
          const buffers = []
          for (let i = 0; i < raw.length; i += 3200) buffers.push(raw.buffer.slice(i, Math.min(i + 3200, raw.length)))
          const heapBefore = performance.memory?.usedJSHeapSize ?? null
          const start = performance.now(), epoch = performance.timeOrigin + start
          const merged = new Uint8Array(raw.length)
          let offset = 0
          for (const buffer of buffers) { merged.set(new Uint8Array(buffer), offset); offset += buffer.byteLength }
          const mergeMs = performance.now() - start
          const audio = mode === 'base64' ? baselineByteLoopBase64(merged)
            : mode === 'chunked' ? uint8ArrayToBase64(merged) : merged
          const encodeMs = performance.now() - start - mergeMs
          const send = performance.now()
          const response = await invoke('benchmark_receive', mode === 'binary' ? audio
            : {request: {audio_b64: audio, sample_rate: 16000, asr_config: {provider: 'synthetic', api_key: '', app_id: ''}}})
          if (response.bytes !== raw.length || response.checksum !== checksum) throw new Error('PCM changed in IPC')
          rows.push({seconds, mode, trial, pcm_bytes: raw.length, payload_bytes: audio.length,
            merge_ms: mergeMs, encode_ms: encodeMs, stop_receive_ms: response.received_ms - epoch,
            invoke_receive_ms: response.received_ms - (performance.timeOrigin + send),
            roundtrip_ms: performance.now() - start, decode_ms: response.decode_ms,
            heap_before: heapBefore, heap_after: performance.memory?.usedJSHeapSize ?? null})
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
    }
    await invoke('benchmark_finish', {report: {user_agent: navigator.userAgent, rows}})
  } catch (error) {
    await invoke('benchmark_finish', {report: {error: String(error), rows}})
  }
}, {once: true})
