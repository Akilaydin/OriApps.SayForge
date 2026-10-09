import { beforeEach, describe, expect, it, vi } from 'vitest'
const { invoke } = vi.hoisted(()=>({invoke:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({invoke}))
import { setAutoLaunchVerified } from '../bridge'
beforeEach(()=>invoke.mockReset())
describe('verified Windows autostart changes',()=>{
  it.each([true,false])('confirms %s against the OS',async enabled=>{
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(enabled)
    await expect(setAutoLaunchVerified(enabled)).resolves.toBe(enabled)
    expect(invoke.mock.calls).toEqual([['set_auto_launch',{enable:enabled}],['get_auto_launch']])
  })
  it('does not report success for a denied write',async()=>{
    invoke.mockRejectedValueOnce(new Error('Synthetic access denied'))
    await expect(setAutoLaunchVerified(true)).rejects.toThrow('Synthetic access denied')
    expect(invoke).toHaveBeenCalledOnce()
  })
  it('does not confirm an unreadable or mismatched OS state',async()=>{
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Synthetic read failed'))
    await expect(setAutoLaunchVerified(true)).rejects.toThrow('Synthetic read failed')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(false)
    await expect(setAutoLaunchVerified(true)).rejects.toThrow('did not match')
  })
})
