import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn(), list: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }))
vi.mock('../bridge', () => ({ saveTextExport: mocks.write }))
vi.mock('../store', () => ({ listHistory: mocks.list, getSetting: vi.fn() }))
import { exportHistory } from '../exports'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue([
    { timestamp: 1000, asrText: 'Synthetic source', llmText: 'Synthetic cleaned', audioFilePath: 'old.wav' },
    { timestamp: 2000, asrText: 'Synthetic fallback', llmText: '' },
  ])
  mocks.save.mockResolvedValue('synthetic.txt')
  mocks.write.mockResolvedValue('synthetic.txt')
})

describe('text history export', () => {
  it('exports all search results as text without audio paths or other metadata', async () => {
    await exportHistory({ keyword: 'Synthetic', limit: 1 })
    expect(mocks.list).toHaveBeenCalledWith({ keyword: 'Synthetic' })
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: 'synthetic.txt',
      content: '1970-01-01T00:00:01.000Z\nSynthetic cleaned\n\n1970-01-01T00:00:02.000Z\nSynthetic fallback',
    }))
  })
  it('does not write when the save dialog is canceled', async () => {
    mocks.save.mockResolvedValue(null)
    expect(await exportHistory()).toEqual({ canceled: true, filePath: null })
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it('reports write failure instead of claiming the export succeeded', async () => {
    mocks.write.mockRejectedValue(new Error('Synthetic write failure'))
    await expect(exportHistory()).rejects.toThrow('Synthetic write failure')
  })
})
