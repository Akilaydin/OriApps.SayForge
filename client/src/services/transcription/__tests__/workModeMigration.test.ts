import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))

import { getSetting, setSetting } from '../../store'
import { initProviderFromStore, getWorkMode, normalizeWorkMode } from '../index'

beforeEach(() => { vi.resetAllMocks(); vi.mocked(setSetting).mockResolvedValue(undefined) })

describe('migrating voice engine preferences without local or Server Mode', () => {
  it('normalizes supported and retired modes', () => {
    expect(normalizeWorkMode('local')).toBe('cloud_api')
    expect(normalizeWorkMode('cloud_api')).toBe('cloud_api')
  })

  it('persists the local-to-cloud migration without touching model settings', async () => {
    vi.mocked(getSetting).mockResolvedValue('local')
    await initProviderFromStore()
    expect(getWorkMode()).toBe('cloud_api')
    expect(setSetting).toHaveBeenCalledExactlyOnceWith('workMode','cloud_api')
  })
  it('keeps startup usable if migration persistence fails', async () => {
    vi.mocked(getSetting).mockResolvedValue('local')
    vi.mocked(setSetting).mockRejectedValue(new Error('Synthetic storage failure'))
    await expect(initProviderFromStore()).resolves.toBeUndefined()
    expect(getWorkMode()).toBe('cloud_api')
  })
  it.each(['local', 'server', 'unknown', '', null, undefined])(
    'falls back to Cloud API for unsupported legacy value %s',
    (stored) => {
      expect(normalizeWorkMode(stored)).toBe('cloud_api')
    },
  )
})
