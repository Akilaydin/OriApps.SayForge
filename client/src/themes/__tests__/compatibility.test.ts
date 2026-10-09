import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { getSetting, setSetting } = vi.hoisted(()=>({getSetting:vi.fn(),setSetting:vi.fn()}))
vi.mock('@/services/store',()=>({getSetting,setSetting}))
import { applyTheme, getTheme, themeList } from '..'
import { initTheme, switchTheme } from '@/stores/theme'

let classes: Set<string>, properties: Map<string,string>
beforeEach(()=>{
  classes=new Set(); properties=new Map()
  vi.stubGlobal('document',{documentElement:{style:{setProperty:(key:string,value:string)=>properties.set(key,value)},classList:{add:(key:string)=>classes.add(key),remove:(key:string)=>classes.delete(key)}},body:{style:{fontFamily:''}}})
  getSetting.mockReset(); setSetting.mockReset().mockResolvedValue(undefined)
})
afterEach(()=>vi.unstubAllGlobals())
describe('retained themes and legacy settings',()=>{
  it.each(['teal','teal-dark','unknown','constructor','toString','__proto__'])('falls back safely for %s',id=>{
    expect(getTheme(id).id).toBe('light')
    expect(applyTheme(id)).toBe('light')
    expect(classes.has('theme-light')).toBe(true)
  })
  it.each(['light','dark','claude'])('applies every declared variable for %s',id=>{
    expect(applyTheme(id)).toBe(id)
    expect(Object.fromEntries(properties)).toMatchObject(getTheme(id).vars)
    expect(classes.has('dark')).toBe(getTheme(id).isDark)
    expect(themeList.map(theme=>theme.id)).toEqual(['light','dark','claude'])
    expect(document.body.style.fontFamily).toMatch(/^"Segoe UI"/)
    expect(document.body.style.fontFamily).toBe('"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif')
  })
  it('does not overwrite a stored legacy value during initialization',async()=>{
    getSetting.mockResolvedValue('teal-dark')
    await expect(initTheme()).resolves.toBe('light')
    expect(setSetting).not.toHaveBeenCalled()
    expect(getSetting).toHaveBeenCalledWith('theme','light')
  })
  it('switches from the warm theme to dark and persists only the explicit choice',async()=>{
    applyTheme('claude')
    await expect(switchTheme('dark')).resolves.toBe('dark')
    expect(classes.has('theme-claude')).toBe(false)
    expect(classes.has('theme-dark')).toBe(true)
    expect(setSetting).toHaveBeenCalledWith('theme','dark')
  })
})
