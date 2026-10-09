import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import WelcomeGuide from './components/WelcomeGuide'
import UpdatePrompt from './components/UpdatePrompt'
import Home from './pages/Home'
import History from './pages/History'
import Dictionary from './pages/Dictionary'
import Settings from './pages/Settings'
import VoiceEnginePage from './features/settings/VoiceEnginePage'
import AIServicePage from './features/settings/AIServicePage'
import AIInstructionsPage from './features/settings/AIInstructionsPage'
import About from './pages/About'
import { initRecorder, cleanup } from './services/recorder'
import { initTheme } from './stores/theme'
import { initAiEnabled } from './stores/aiEnabled'
import { getSetting, setSetting } from './services/store'
import * as bridge from './services/bridge'
import { checkForUpdates } from './services/appUpdates'

export default function App() {
  const [showWelcome, setShowWelcome] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    void initTheme()
    void initAiEnabled()
    initRecorder()
    void checkForUpdates()

      ; (async () => {
        const onboardedVersion = await getSetting('onboardingVersion', '')
        if (!onboardedVersion) {
          setShowWelcome(true)
        }
        setOnboardingChecked(true)
      })()

    return () => {
      cleanup()
    }
  }, [])

  useEffect(() => {
    const unlistenOpenAbout = listen('open-about', () => {
      navigate('/about')
    })
    return () => {
      void unlistenOpenAbout.then((fn) => fn())
    }
  }, [navigate])

  const handleWelcomeComplete = () => {
    setShowWelcome(false)
    void setSetting('onboardingVersion', __APP_VERSION__)
    bridge.notifyShortcutsChanged()
  }

  if (!onboardingChecked) {
    return <div className="h-screen bg-background" />
  }

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="custom-scrollbar flex-1 overflow-y-auto bg-background p-8">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/favorites" element={<Navigate to="/history" replace />} />
            <Route path="/hotwords" element={<Dictionary />} />
            <Route path="/dictionary" element={<Navigate to="/hotwords" replace />} />
            <Route path="/voice-engine" element={<VoiceEnginePage />} />
            <Route path="/ai-instructions" element={<AIInstructionsPage />} />
            <Route path="/ai-service" element={<AIServicePage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
      </div>
      {showWelcome && <WelcomeGuide onComplete={handleWelcomeComplete} />}
      {!showWelcome && <UpdatePrompt />}
    </div>
  )
}
