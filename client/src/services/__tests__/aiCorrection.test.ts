import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  invoke: vi.fn(),
  log: vi.fn(),
}))

vi.mock('../bridge', () => ({ invoke: mocks.invoke }))
vi.mock('../debugLog', () => ({ addRuntimeEvent: mocks.log }))
vi.mock('../aiCorrectionSettings', () => ({
  DEFAULT_AI_CORRECTION_PROMPT: 'Default correction instructions',
  loadAiCorrectionSettings: mocks.load,
  isAiCorrectionConfigured: (value: { apiUrl: string; apiKey: string; model: string }) =>
    Boolean(value.apiUrl.trim() && value.apiKey.trim() && value.model.trim()),
}))

import { correctTranscript } from '../aiCorrection'

const configured = {
  enabled: true,
  apiUrl: 'https://asr.example/v1',
  apiKey: 'example-test-key',
  model: 'example-model',
  prompt: 'Preserve technical terms.',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue({ ...configured })
  mocks.invoke.mockResolvedValue({ text: 'Corrected transcript', elapsed_ms: 25 })
})

describe('optional AI correction', () => {
  it('does not request a second model when disabled', async () => {
    mocks.load.mockResolvedValue({ ...configured, enabled: false })
    expect(await correctTranscript('Raw transcript')).toEqual({ text: 'Raw transcript', elapsedMs: 0, status: 'skipped' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('does not request correction for empty ASR text', async () => {
    expect(await correctTranscript('   ')).toEqual({ text: '   ', elapsedMs: 0, status: 'skipped' })
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('uses a separate chat completion request and returns corrected text', async () => {
    expect(await correctTranscript('Raw transcript')).toEqual({ text: 'Corrected transcript', elapsedMs: 25, status: 'applied' })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('cloud_polish', {
      request: {
        text: 'Raw transcript',
        ai_config: { provider: 'openai_compat', api_url: configured.apiUrl, api_key: configured.apiKey, model: configured.model },
        system_prompt: 'Preserve technical terms.',
      },
    })
  })

  it('does not send requests with incomplete AI configuration', async () => {
    mocks.load.mockResolvedValue({ ...configured, apiKey: '' })
    expect((await correctTranscript('Raw transcript'))?.status).toBe('unavailable')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('preserves ASR text when the second model fails, returns empty output or settings cannot be read', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('Synthetic API error with secret details'))
    expect((await correctTranscript('Raw transcript'))?.text).toBe('Raw transcript')
    mocks.invoke.mockResolvedValueOnce({ text: '', elapsed_ms: 2 })
    expect((await correctTranscript('Raw transcript'))?.text).toBe('Raw transcript')
    mocks.load.mockRejectedValueOnce(new Error('Synthetic settings error with secret details'))
    expect((await correctTranscript('Raw transcript'))?.text).toBe('Raw transcript')
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('secret details')
  })

  it('drops an old run before the request if recording was canceled while reading settings', async () => {
    let resolveSettings!: (value: typeof configured) => void
    mocks.load.mockReturnValue(new Promise((resolve) => { resolveSettings = resolve }))
    let current = true
    const pending = correctTranscript('Canceled transcript', () => current)
    current = false
    resolveSettings(configured)
    expect(await pending).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('drops an old run if correction completes after cancellation', async () => {
    let resolveCorrection!: (value: { text: string; elapsed_ms: number }) => void
    mocks.invoke.mockReturnValue(new Promise((resolve) => { resolveCorrection = resolve }))
    let current = true
    const pending = correctTranscript('Canceled transcript', () => current)
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce())
    current = false
    resolveCorrection({ text: 'Late correction', elapsed_ms: 40 })
    expect(await pending).toBeNull()
  })

  it('falls back to raw text when optional correction exceeds its deadline', async () => {
    vi.useFakeTimers()
    try {
      mocks.invoke.mockReturnValue(new Promise(() => {}))
      const pending = correctTranscript('Raw transcript')
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(16_000)
      expect(await pending).toEqual({ text: 'Raw transcript', elapsedMs: 16_000, status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })
})
