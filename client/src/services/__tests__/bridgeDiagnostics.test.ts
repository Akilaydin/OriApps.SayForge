import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn(), failLogTransport: false }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => {
    const result = native.invoke(command, args)
    // A spy observes rejected promises internally; reject outside it so this
    // case exercises a genuinely unhandled transport failure before the fix.
    if (native.failLogTransport && command === 'append_debug_log') {
      return Promise.reject(new Error('Synthetic log transport failure'))
    }
    return result
  },
}))

beforeEach(() => { vi.resetModules(); native.invoke.mockReset(); native.failLogTransport = false })

describe('native failure diagnostics', () => {
  it('retains the failing operation and HTTP cause while keeping IPC arguments and response contents out of the log', async () => {
    const failure = new Error('HTTP 503: SYNTHETIC_PRIVATE_RESPONSE api_key=SYNTHETIC_SECRET')
    native.invoke.mockImplementation((command) => command === 'append_debug_log'
      ? Promise.resolve()
      : Promise.reject(failure))
    const bridge = await import('../bridge')
    await expect(bridge.copyText('SYNTHETIC_TRANSCRIPT')).rejects.toBe(failure)
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('append_debug_log', {
      payload: expect.objectContaining({ source: 'ipc', detail: expect.objectContaining({
        operation: 'copy_text', error: expect.objectContaining({ kind: 'http', httpStatus: 503 }),
      }) }),
    }))
    const logs = JSON.stringify(native.invoke.mock.calls.filter(([command]) => command === 'append_debug_log'))
    for (const privateValue of ['SYNTHETIC_TRANSCRIPT', 'SYNTHETIC_SECRET', 'SYNTHETIC_PRIVATE_RESPONSE']) {
      expect(logs).not.toContain(privateValue)
    }
  })

  it('absorbs a rejected log transport without reporting another IPC failure or stopping the next user action', async () => {
    native.failLogTransport = true
    native.invoke.mockResolvedValue('Synthetic clipboard success')
    const bridge = await import('../bridge')
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try {
      bridge.appendDebugLog({ kind: 'runtime', level: 'warn', source: 'synthetic', message: 'Synthetic log' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await expect(bridge.copyText('Synthetic text')).resolves.toBe('Synthetic clipboard success')
      expect(native.invoke.mock.calls.filter(([command]) => command === 'append_debug_log')).toHaveLength(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })
})
