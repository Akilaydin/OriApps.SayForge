import CloudAPISection from './CloudAPISection'
import AsrTestSection from './AsrTestSection'
import { useT } from '@/i18n/useT'

export default function VoiceEnginePage() {
  const t = useT()
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold">{t('nav.voiceEngine')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('voiceEngine.subtitle')}</p>
      <div className="space-y-6">
        <div id="engine-config"><CloudAPISection /></div>
        <AsrTestSection workMode="cloud_api" />
      </div>
    </div>
  )
}
