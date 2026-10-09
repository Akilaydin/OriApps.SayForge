import React from 'react'
import ReactDOM from 'react-dom/client'
import { listen } from '@tauri-apps/api/event'
import { initLanguage } from '@/stores/language'
import { initTheme } from '@/stores/theme'
import TrayMenu from './TrayMenu'
import './tray-menu.css'
import '@/index.css'

async function bootstrap() {
  await Promise.all([initLanguage(), initTheme()])

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <TrayMenu />
    </React.StrictMode>,
  )
}

window.addEventListener('contextmenu', (event) => event.preventDefault())

void listen('tray-menu-open', () => {
  void initLanguage()
  void initTheme()
})

void bootstrap()
