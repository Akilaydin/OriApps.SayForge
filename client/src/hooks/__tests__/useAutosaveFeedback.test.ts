import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, cursor: 0,
  effect: null as null | (() => void | (() => void)), status: '', toast: vi.fn() }))
vi.mock('react', () => ({
  useState: () => [hooks.status, (value: string) => { hooks.status = value }],
  useRef: (value: unknown) => hooks.refs[hooks.cursor++] ?? (hooks.refs[hooks.cursor - 1] = { current: value }),
  useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect },
}))
vi.mock('@/services/actionFeedback', () => ({ showToast: hooks.toast }))
import { useAutosaveFeedback } from '../useAutosaveFeedback'

beforeEach(() => { hooks.refs = []; hooks.cursor = 0; hooks.status = ''; hooks.toast.mockReset() })

function render(value: string, ready: boolean, save: (value: string) => Promise<void>, notice?: { current: string | undefined }) {
  hooks.cursor = 0
  useAutosaveFeedback(value, ready, save, notice)
  return hooks.effect!()
}
const settled = () => hooks.refs[0].current as Promise<void>

describe('autosave outcomes', () => {
  it('does not persist defaults before stored data has loaded', async () => {
    const save = vi.fn()
    render('default', false, save)
    await settled()
    expect(save).not.toHaveBeenCalled()
    expect(hooks.status).toBe('')
  })

  it('serializes writes and reports only the latest completed snapshot', async () => {
    let finishFirst!: () => void, finishSecond!: () => void
    const save = vi.fn((value: string) => new Promise<void>((resolve) => {
      if (value === 'first') finishFirst = resolve
      else finishSecond = resolve
    }))
    const cleanup = render('first', true, save)
    const firstSettled = settled()
    await Promise.resolve()
    cleanup!()
    render('second', true, save)
    expect(hooks.status).toBe('Saving changes…')
    expect(save.mock.calls).toEqual([['first']])
    finishFirst()
    await firstSettled
    await Promise.resolve()
    expect(save.mock.calls).toEqual([['first'], ['second']])
    expect(hooks.status).toBe('Saving changes…')
    finishSecond()
    await settled()
    expect(hooks.status).toBe('Saved')
  })

  it('reports a failed save without a success toast and can retry', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('synthetic storage failure')).mockResolvedValue(undefined)
    render('failed', true, save, { current: 'Deleted' })
    await settled()
    expect(hooks.status).toContain('Could not save')
    expect(hooks.toast).toHaveBeenCalledWith('error', expect.stringContaining('Could not save'))
    expect(hooks.toast).not.toHaveBeenCalledWith('success', expect.anything())
    render('retried', true, save)
    await settled()
    expect(hooks.status).toBe('Saved')
  })

  it('announces explicit deletion only after its snapshot was stored', async () => {
    let finish!: () => void
    const save = () => new Promise<void>((resolve) => { finish = resolve })
    const notice = { current: 'Deleted' as string | undefined }
    render('remaining synthetic rules', true, save, notice)
    await Promise.resolve()
    expect(hooks.toast).not.toHaveBeenCalled()
    finish()
    await settled()
    expect(hooks.toast).toHaveBeenCalledWith('success', 'Deleted')
    expect(notice.current).toBeUndefined()
  })

  it('still reports a failed last save after the page unmounts', async () => {
    let fail!: (cause: Error) => void
    const cleanup = render('last snapshot', true, () => new Promise<void>((_resolve, reject) => { fail = reject }))
    await Promise.resolve()
    cleanup!()
    fail(new Error('synthetic storage failure'))
    await settled()
    expect(hooks.toast).toHaveBeenCalledWith('error', expect.stringContaining('Could not save'))
    expect(hooks.status).toBe('Saving changes…')
  })
})
