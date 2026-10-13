import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
import { dismissToast, getFeedbackState, pauseToast, resumeToast, runAction, showToast } from '../actionFeedback'
import { ToastViewport } from '@/components/ActionFeedback'

beforeEach(() => { vi.useFakeTimers(); dialog.confirm.mockReset(); dialog.confirm.mockResolvedValue(true) })
afterEach(() => { getFeedbackState().toasts.forEach((toast) => dismissToast(toast.id)); vi.useRealTimers() })

describe('confirmed user-action feedback', () => {
  it('waits for persistence and suppresses an immediate duplicate Save', async () => {
    let finish!: () => void
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const pending = runAction('save-test', save, { success: 'Saved' })
    expect(getFeedbackState().actions['save-test']).toBe('pending')
    expect(getFeedbackState().toasts).toEqual([])
    expect(await runAction('save-test', save, { success: 'Saved' })).toBe(false)
    expect(save).toHaveBeenCalledOnce()
    finish()
    expect(await pending).toBe(true)
    expect(getFeedbackState().toasts).toMatchObject([{ tone: 'success', message: 'Saved' }])
  })

  it('never announces success or exposes an error payload after failed persistence', async () => {
    expect(await runAction('failed-save', async () => { throw new Error('synthetic private payload') }, {
      success: 'Saved', error: 'Could not save. Retry.',
    })).toBe(false)
    expect(getFeedbackState().actions['failed-save']).toBe('error')
    expect(getFeedbackState().toasts).toMatchObject([{ tone: 'error', message: 'Could not save. Retry.' }])
    expect(JSON.stringify(getFeedbackState())).not.toContain('synthetic private payload')
    expect(await runAction('failed-save', async () => {}, { success: 'Saved' })).toBe(true)
  })

  it('Cancel never invokes destructive work or reports an error/success', async () => {
    dialog.confirm.mockResolvedValue(false)
    const remove = vi.fn()
    expect(await runAction('delete-cancel', remove, { confirmation: 'Delete?', success: 'Deleted' })).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(getFeedbackState().actions['delete-cancel']).toBe('idle')
    expect(getFeedbackState().toasts).toEqual([])
  })

  it('waits for confirmation before deletion and its outcome before success', async () => {
    let approve!: (allowed: boolean) => void, finish!: () => void
    dialog.confirm.mockReturnValue(new Promise<boolean>((resolve) => { approve = resolve }))
    const remove = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const pending = runAction('delete-success', remove, { confirmation: 'Delete?', success: 'Deleted' })
    expect(remove).not.toHaveBeenCalled()
    expect(await runAction('delete-success', remove, { confirmation: 'Delete?' })).toBe(false)
    expect(dialog.confirm).toHaveBeenCalledOnce()
    approve(true)
    await Promise.resolve()
    expect(remove).toHaveBeenCalledOnce()
    expect(getFeedbackState().toasts).toEqual([])
    finish()
    expect(await pending).toBe(true)
    expect(getFeedbackState().toasts).toMatchObject([{ tone: 'success', message: 'Deleted' }])
  })

  it('treats a canceled file dialog as neutral instead of export success', async () => {
    await runAction('export-cancel', async () => false, { success: 'Export complete', canceled: 'Canceled' })
    expect(getFeedbackState().toasts).toMatchObject([{ tone: 'info', message: 'Canceled' }])
  })

  it('import failure produces only an error notification', async () => {
    await runAction('import-failure', async () => { throw new Error('synthetic malformed file') }, {
      success: 'Import complete', error: 'Check the file and try again.',
    })
    expect(getFeedbackState().toasts).toMatchObject([{ tone: 'error', message: 'Check the file and try again.' }])
  })

  it('bounds the stack and groups identical messages', () => {
    showToast('success', 'Saved'); showToast('success', 'Saved')
    expect(getFeedbackState().toasts).toHaveLength(1)
    showToast('info', 'Second'); showToast('info', 'Third'); showToast('info', 'Fourth')
    expect(getFeedbackState().toasts.map((toast) => toast.message)).toEqual(['Second', 'Third', 'Fourth'])
    vi.advanceTimersByTime(5000)
    expect(getFeedbackState().toasts).toEqual([])
  })

  it('keeps focused/hovered notifications alive even when the message repeats', () => {
    showToast('error', 'Retry')
    const id = getFeedbackState().toasts[0].id
    pauseToast(id); showToast('error', 'Retry')
    vi.advanceTimersByTime(20_000)
    expect(getFeedbackState().toasts).toHaveLength(1)
    resumeToast(id)
    vi.advanceTimersByTime(10_000)
    expect(getFeedbackState().toasts).toEqual([])
  })

  it('renders keyboard dismissal and live announcements without taking focus', () => {
    showToast('success', 'Saved'); showToast('error', 'Retry')
    const html = renderToStaticMarkup(createElement(ToastViewport))
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Dismiss notification</button>')
    expect(html).toContain('border-emerald-500/40')
    expect(html).not.toContain('autofocus')
  })
})
