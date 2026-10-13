import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

const setup = vi.hoisted(() => ({ render: vi.fn(), defaults: vi.fn(), provider: vi.fn(), report: vi.fn() }))
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: setup.render }) } }))
vi.mock('../App', () => ({ default: () => null }))
vi.mock('../stores/language', () => ({ initLanguage: () => {} }))
vi.mock('../stores/providerDefaults', () => ({ initProviderDefaults: setup.defaults }))
vi.mock('../services/transcription', () => ({ initProviderFromStore: setup.provider }))
vi.mock('../services/webviewKeyboardFallback', () => ({ startWebviewKeyboardFallback: () => Promise.resolve() }))
vi.mock('../services/debugLog', () => ({ addRuntimeEvent: vi.fn(), reportRuntimeFailure: setup.report }))

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks() })

describe('startup failure feedback', () => {
  it('renders a retryable startup failure and logs its cause instead of leaving a blank window', async () => {
    const failure = new Error('Permission denied: SYNTHETIC_PRIVATE_SETTINGS')
    setup.defaults.mockRejectedValue(failure)
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    vi.stubGlobal('document', { getElementById: () => ({}) })
    const ignoreBaselineRejection = () => {}
    process.on('unhandledRejection', ignoreBaselineRejection)
    try {
      await import('../main')
      await vi.waitFor(() => expect(setup.render).toHaveBeenCalled())
      const html = renderToStaticMarkup(setup.render.mock.calls.at(-1)![0] as ReactElement)
      expect(html).toMatch(/could not start|couldn't start|could not initialize/i)
      expect(html).toContain('role="alert"')
      expect(html).toMatch(/retry|try again/i)
      expect(html).not.toContain('SYNTHETIC_PRIVATE_SETTINGS')
      expect(setup.report).toHaveBeenCalledWith('startup', 'initialize', failure)
      expect(setup.provider).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', ignoreBaselineRejection)
    }
  })
})
