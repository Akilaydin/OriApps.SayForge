import { existsSync, readFileSync } from 'node:fs'
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

  it('uses the official signed updater without restoring the retired installer service', () => {
    const app = text('src/App.tsx')
    const main = text('src-tauri/src/main.rs')
    expect(app).not.toMatch(/\bstartUpdateService\s*\(/)
    expect(app).not.toContain('<UpdateNotificationHost')
    expect(app).not.toContain('<UpdateDialog')
    expect(main).not.toMatch(/\binstall_pending_update_on_exit\s*\(/)
    expect(text('src/pages/About.tsx')).toContain('https://github.com/Akilaydin/OriApps.SayForge')
    for (const retired of ['src/services/runtimeConfig.ts', '.env.development', 'update-notification.html', 'src-tauri/src/commands/update_notification.rs']) {
      expect(existsSync(resolve(process.cwd(), retired))).toBe(false)
    }
    expect(text('vite.config.ts')).not.toMatch(/SAYFORGE_DEFAULT_SERVER_URL|updateNotification|FAKE_APP_VERSION/)
    expect(main).not.toMatch(/commands::(?:update_notification|system::(?:download_update|verify_update_package|install_downloaded_update))/)
    expect(text('src-tauri/Cargo.toml')).toContain('tauri-plugin-updater')
    expect(text('src-tauri/Cargo.toml')).not.toContain('tauri-plugin-process')
    const dependencies = JSON.parse(text('package.json')).dependencies
    expect(dependencies).toHaveProperty('@tauri-apps/plugin-updater')
    expect(dependencies).not.toHaveProperty('@tauri-apps/plugin-process')
    const apiVersion = dependencies['@tauri-apps/api'] as string
    const updaterVersion = dependencies['@tauri-apps/plugin-updater'] as string
    const rustUpdater = text('src-tauri/Cargo.toml').match(/^tauri-plugin-updater\s*=\s*"=([^"]+)"/m)?.[1]
    const rustCore = text('src-tauri/Cargo.lock').match(/\[\[package\]\]\s+name = "tauri"\s+version = "([^"]+)"/)?.[1]
    expect(apiVersion).toMatch(/^2\.10\./)
    expect(rustCore).toMatch(/^2\.10\./)
    expect(updaterVersion.split('.').slice(0, 2)).toEqual(rustUpdater?.split('.').slice(0, 2))
    const capabilities = JSON.parse(text('src-tauri/capabilities/default.json'))
    expect(capabilities.windows).not.toContain('update-notification')
    expect(capabilities.permissions).not.toContain('updater:default')
    const updaterCapability = JSON.parse(text('src-tauri/capabilities/updater.json'))
    expect(updaterCapability.windows).toEqual(['main'])
    expect(updaterCapability.permissions).toEqual(['updater:default'])
    const config = JSON.parse(text('src-tauri/tauri.conf.json'))
    expect(config.bundle.createUpdaterArtifacts).toBe(true)
    expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(config.plugins.updater.endpoints).toEqual([
      'https://github.com/Akilaydin/OriApps.SayForge/releases/latest/download/latest.json',
    ])
    expect(config.plugins.updater.windows.installMode).toBe('passive')
    expect(app).toContain('checkForUpdates()')
    expect(text('src/services/appUpdates.ts')).toContain('postponeUpdate()')
    const about = text('src/pages/About.tsx')
    expect(about).toContain('v{__APP_VERSION__}')
    expect(about).toContain('shellOpen(RELEASES_URL)')
    expect(existsSync(resolve(process.cwd(), 'src-tauri/src/providers/asr_openrouter.rs'))).toBe(false)
  })

  it('keeps explicit credit and licensing for the original project', () => {
    const readme = text('../README.md')
    const heading = '## License and third-party notices'
    expect(readme).toContain(heading)
    const about = text('src/pages/About.tsx')
    expect(about).toContain('const ATTRIBUTION_URL = `${REPO_URL}/blob/main/README.md#license-and-third-party-notices`')
    expect(about).toContain('shellOpen(ATTRIBUTION_URL)')
    const [publicDescription, legalSection] = readme.split(heading)
    expect(publicDescription).not.toContain('github.com/crosswk/')
    expect(legalSection).toContain('github.com/crosswk/')
    expect(legalSection).toContain('based on')
    expect(text('../THIRD_PARTY_NOTICES.md')).toContain('LGPL-3.0')
  })
})
