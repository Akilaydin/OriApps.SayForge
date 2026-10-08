
import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { getSetting, setSetting } from '@/services/store'
import { switchProvider, getWorkMode, type WorkMode } from '@/services/transcription'
import { refreshRecorderSettings, reconnectProvider } from '@/services/recorder'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import WorkModeSection from './WorkModeSection'
import CloudAPISection from './CloudAPISection'
import LocalModeSection, { LocalModeAdvancedSection } from './LocalModeSection'
import ServerSection from './ServerSection'
import AsrTestSection from './AsrTestSection'
import { useT } from '@/i18n/useT'

export default function VoiceEnginePage() {
  const t = useT()
  const [workMode, setWorkMode] = useState<WorkMode>(getWorkMode)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    getSetting('workMode', 'server').then((value) => {
      const v = value as WorkMode
      if (v === 'server' || v === 'cloud_api' || v === 'local') setWorkMode(v)
    })
  }, [])

  const handleWorkModeChange = async (mode: WorkMode) => {
    setEngineDraftDirty(false)
    setWorkMode(mode)
    await setSetting('workMode', mode)
    await switchProvider(mode)
    await refreshRecorderSettings()
    reconnectProvider()
    void refreshModeStatus()
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold">{t('nav.voiceEngine')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {t('voiceEngine.subtitle')}
      </p>

      <div className="space-y-6">
        <WorkModeSection value={workMode} onChange={(m) => void handleWorkModeChange(m)} />

        <div id="engine-config" className="space-y-6">
          {workMode === 'local' && <LocalModeSection />}
          {workMode === 'server' && <ServerSection />}
          {workMode === 'cloud_api' && <CloudAPISection />}
        </div>

        <AsrTestSection workMode={workMode} />

        {workMode === 'local' && (
          <section className="space-y-6">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="local-advanced"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
              <span className="font-medium">{t('voiceEngine.advanced')}</span>
              <span className="text-xs">{t('voiceEngine.advancedDesc')}</span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </button>

            {advancedOpen && (
              <div id="local-advanced" className="space-y-6">
                <LocalModeAdvancedSection />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
