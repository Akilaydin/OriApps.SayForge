import { describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import { normalizeWorkMode } from '../index'

describe('migrating voice engine preferences without the removed Server Mode', () => {
  it('keeps supported modes unchanged', () => {
    expect(normalizeWorkMode('local')).toBe('local')
    expect(normalizeWorkMode('cloud_api')).toBe('cloud_api')
  })

  it.each(['server', 'unknown', '', null, undefined])(
    'falls back to Cloud API for unsupported legacy value %s',
    (stored) => {
      expect(normalizeWorkMode(stored)).toBe('cloud_api')
    },
  )
})
