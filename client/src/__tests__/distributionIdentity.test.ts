import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path))
const text = (path: string) => read(path).toString('utf8')

describe('independent SayForge distribution', () => {
  it('has a separate Tauri identity, app name and Windows executable', () => {
    const conf = JSON.parse(text('src-tauri/tauri.conf.json')) as {
      productName: string
      identifier: string
    }
    const pkg = JSON.parse(text('package.json')) as { name: string }
    expect(conf.productName).toBe('SayForge')
    expect(conf.identifier).toBe('com.oriapps.sayforge')
    expect(pkg.name).toBe('oriapps-sayforge')
    expect(text('src-tauri/Cargo.toml')).toContain('name = "sayforge"')
  })

  it('ships the placeholder icon in PNG and multi-resolution ICO formats', () => {
    for (const name of ['src-tauri/icons/icon.png', 'src/assets/icon-128.png', 'src-tauri/icons/tray-16.png']) {
      expect(read(name).subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
    }
    const ico = read('src-tauri/icons/icon.ico')
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBeGreaterThan(1)
  })

  it('never activates the original SayIt installer or update service', () => {
    const app = text('src/App.tsx')
    const main = text('src-tauri/src/main.rs')
    expect(app).not.toMatch(/\bstartUpdateService\s*\(/)
    expect(app).not.toContain('<UpdateNotificationHost')
    expect(app).not.toContain('<UpdateDialog')
    expect(main).not.toMatch(/\binstall_pending_update_on_exit\s*\(/)
    expect(text('src/pages/About.tsx')).toContain('https://github.com/Akilaydin/OriApps.SayForge')
    expect(text('src/services/runtimeConfig.ts')).not.toContain('sayitapp.site')
    expect(text('.env.development')).not.toContain('sayitapp.site')
    expect(text('src-tauri/src/providers/asr_openrouter.rs')).not.toContain('https://sayitapp.site')
  })

  it('keeps explicit credit and licensing for the original project', () => {
    expect(text('../README.md')).toContain('https://github.com/crosswk/SayIt')
    expect(text('../README.md')).toContain('based on')
    expect(text('../THIRD_PARTY_NOTICES.md')).toContain('LGPL-3.0')
  })
})
