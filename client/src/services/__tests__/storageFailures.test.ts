import { beforeEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ historyList: vi.fn(), historyCount: vi.fn() }))
vi.mock('../bridge', () => native)
import { countHistory, listHistory } from '../store'

beforeEach(() => vi.clearAllMocks())

it('does not report a failed history query as an empty history', async () => {
  const error = new Error('sayforge_error:storage_locked:sqlite_code=DatabaseBusy')
  native.historyList.mockRejectedValue(error)
  native.historyCount.mockRejectedValue(error)
  await expect(listHistory()).rejects.toBe(error)
  await expect(countHistory()).rejects.toBe(error)
})

it('still returns a genuinely empty history', async () => {
  native.historyList.mockResolvedValue([])
  native.historyCount.mockResolvedValue(0)
  await expect(listHistory()).resolves.toEqual([])
  await expect(countHistory()).resolves.toBe(0)
})
