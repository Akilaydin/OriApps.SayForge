import { useEffect, useState } from 'react'
import { getAiPrompt, AI_PROMPT_KEY } from '@/services/aiPrompt'
import { setSetting } from '@/services/store'
import { refreshRecorderSettings } from '@/services/recorder'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/ui/feedback'
import AIProofreadToggle from './AIProofreadToggle'
import HotwordPromptInjectToggle from './HotwordPromptInjectToggle'
import { useT } from '@/i18n/useT'

export default function AIInstructionsPage() {
  const t = useT()
  const [prompt, setPrompt] = useState('')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void getAiPrompt().then((value) => { setPrompt(value); setReady(true) }).catch((e) => setError(String(e)))
  }, [])
  const save = async () => {
    setSaving(true); setError('')
    try {
      await setSetting(AI_PROMPT_KEY, prompt)
      await refreshRecorderSettings()
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">{t('nav.aiInstructions')}</h1>
      <AIProofreadToggle />
      <HotwordPromptInjectToggle />
      <label className="block space-y-2">
        <span className="font-medium">{t('aiInstructions.prompt')}</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!ready || saving}
          className="min-h-48 w-full rounded-md border bg-background p-3 text-sm" />
      </label>
      {error && <Feedback tone="error" message={error} />}
      <Button onClick={() => void save()} disabled={!ready || saving}>{t('common.save')}</Button>
    </div>
  )
}
