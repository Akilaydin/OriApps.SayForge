import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/ui/feedback'
import { loadAiProfiles, saveAiProfiles, type AiProfileState } from './aiProfileStore'
import { blankProfile, checkApiUrl, type AiProfile } from './aiProviderCatalog'
import { useT } from '@/i18n/useT'

export default function AIProviderSection() {
  const t = useT()
  const [state, setState] = useState<AiProfileState>({profiles:[],activeId:''})
  const [draft, setDraft] = useState<AiProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    void loadAiProfiles().then((loaded) => {
      if (disposed) return
      setState(loaded)
      setDraft(loaded.profiles.find((p) => p.id === loaded.activeId) ?? blankProfile())
    }).catch((e) => { if (!disposed) { setMessage(String(e)); setFailed(true) } })
    return () => { disposed = true }
  }, [])
  const patch = (value: Partial<AiProfile>) => setDraft((old) => old ? {...old,...value} : old)
  const run = async (test: boolean) => {
    if (!draft) return
    const invalid = checkApiUrl(draft.apiUrl)
    if (!draft.apiUrl.trim() || !draft.model.trim() || !draft.apiKey.trim() || invalid) {
      setMessage(invalid || t('diagnostics.incomplete')); setFailed(true); return
    }
    setBusy(true); setMessage('')
    try {
      if (test) {
        const result = await invoke<{ok:boolean;message:string}>('test_ai_connection', {
          config:{provider:'openai_compat',api_url:draft.apiUrl,api_key:draft.apiKey,model:draft.model},
        })
        setMessage(result.message); setFailed(!result.ok)
      } else {
        const profiles = state.profiles.some((p) => p.id === draft.id)
          ? state.profiles.map((p) => p.id === draft.id ? draft : p) : [...state.profiles,draft]
        const next = {profiles,activeId:draft.id}
        await saveAiProfiles(next); setState(next); setFailed(false)
      }
    } catch (e) { setMessage(String(e)); setFailed(true) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h2 className="text-lg font-semibold">{t('aiProvider.openaiCompat')}</h2>
      {state.profiles.length > 1 && (
        <select aria-label={t('aiProvider.openaiCompat')} value={draft?.id ?? ''} disabled={busy}
          onChange={(e) => setDraft(state.profiles.find((p) => p.id === e.target.value) ?? null)}
          className="w-full rounded-md border bg-background p-2 text-sm">
          {state.profiles.map((p) => <option key={p.id} value={p.id}>{p.model} · {p.apiUrl}</option>)}
        </select>
      )}
      {draft && <>
        <label className="block space-y-1"><span className="text-sm">{t('ai.apiUrl')}</span>
          <input className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={draft.apiUrl} disabled={busy} onChange={(e) => patch({apiUrl:e.target.value})} /></label>
        <label className="block space-y-1"><span className="text-sm">{t('ai.apiKey')}</span>
          <input className="w-full rounded-md border bg-background px-3 py-2 text-sm" type="password" value={draft.apiKey} disabled={busy} onChange={(e) => patch({apiKey:e.target.value})} /></label>
        <label className="block space-y-1"><span className="text-sm">{t('ai.model')}</span>
          <input className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={draft.model} disabled={busy} onChange={(e) => patch({model:e.target.value})} /></label>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void run(false)}>{t('common.save')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void run(true)}>{t('ai.test')}</Button>
        </div>
      </>}
      {message && <Feedback tone={failed ? 'error' : 'success'} message={message} />}
    </div>
  )
}
