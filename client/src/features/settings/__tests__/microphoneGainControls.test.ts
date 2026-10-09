import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import MicrophoneSection from '../MicrophoneSection'

function renderMicSettings(gainEnabled = true, gainDb = 6, gainReady = true) {
  return renderToStaticMarkup(createElement(MicrophoneSection, {
    mics: [],
    selectedMic: '',
    gainEnabled,
    gainDb,
    gainReady,
    gainSaving: false,
    testing: false,
    volumeLevel: 'idle',
    onCanvasRef: vi.fn(),
    onMicChange: vi.fn(),
    onTestMic: vi.fn(),
    onGainEnabledToggle: vi.fn(),
    onGainDbChange: vi.fn(),
    onGainDbCommit: vi.fn(),
  }))
}

describe('microphone boost settings UI', () => {
  it('renders an accessible switch and bounded slider for enabled gain', () => {
    const html = renderMicSettings(true, 12)
    const slider = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? ''
    expect(html).toContain('role="switch" aria-checked="true"')
    expect(html).toContain('Microphone boost')
    expect(html).toContain('not in Windows or other apps')
    expect(slider).toContain('id="mic-gain-db"')
    expect(slider).toContain('min="0"')
    expect(slider).toContain('max="18"')
    expect(slider).toContain('step="1"')
    expect(slider).toContain('value="12"')
    expect(slider).not.toContain('disabled=""')
    expect(html).toContain('+12 dB')
  })

  it('disables the slider but keeps the selected amount when boost is off', () => {
    const html = renderMicSettings(false, 9)
    const slider = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? ''
    expect(html).toContain('role="switch" aria-checked="false"')
    expect(slider).toContain('value="9"')
    expect(slider).toContain('disabled=""')
  })

  it('does not allow changes before persisted settings have loaded', () => {
    const html = renderMicSettings(true, 6, false)
    const slider = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? ''
    expect(slider).toContain('disabled=""')
  })
})
