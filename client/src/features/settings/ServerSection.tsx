
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { Feedback, type FeedbackTone } from '@/components/ui/feedback'
import { Segmented } from '@/components/ui/segmented'
import {
  getBackendBaseUrl,
  getDefaultBackendBaseUrl,
  resetBackendBaseUrl,
  setBackendBaseUrl as persistBackendBaseUrl,
} from '@/services/runtimeConfig'
import { reconnectProvider } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { describeServerError } from '@/lib/errorMessages'
import { t } from '@/i18n'
import { useT } from '@/i18n/useT'

interface ServiceResult {
  tone: FeedbackTone
  message: string
  detail?: string
}

export default function ServerSection() {
  const t = useT()
  const [backendBaseUrl, setBackendBaseUrl] = useState('')
  const [savedBaseUrl, setSavedBaseUrl] = useState('')
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('')
  const [result, setResult] = useState<ServiceResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [asrLanguage, setAsrLanguage] = useState('auto')

  useEffect(() => {
    const current = getBackendBaseUrl()
    setBackendBaseUrl(current)
    setSavedBaseUrl(current)
    setDefaultBaseUrl(getDefaultBackendBaseUrl())
    void getSetting('server.language', 'auto').then((v) => setAsrLanguage(String(v || 'auto')))
    return () => setEngineDraftDirty(false)
  }, [])

  const normalize = (v: string) => v.trim().replace(/\/+$/, '')

  const isDirty = normalize(backendBaseUrl) !== normalize(savedBaseUrl)
  const isCustom = normalize(savedBaseUrl) !== normalize(defaultBaseUrl)

  function handleUrlChange(value: string) {
    setBackendBaseUrl(value)
    setResult(null)
    setEngineDraftDirty(normalize(value) !== normalize(savedBaseUrl))
  }

  async function probeHealth(url: string): Promise<{ asr?: boolean; llm?: boolean }> {
    const response = await fetch(`${url}/healthz`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as { asr?: boolean; llm?: boolean }
  }

  function describeHealth(payload: { asr?: boolean; llm?: boolean }, prefix: string): ServiceResult {
    if (payload.asr === false) {
      return {
        tone: 'warning',
        message: t('server.asrNotReady', { prefix }),
      }
    }
    if (payload.llm === false) {
      return {
        tone: 'success',
        message: t('server.noAi', { prefix }),
      }
    }
    return { tone: 'success', message: t('server.allGood', { prefix }) }
  }

  async function handleSaveAndTest() {
    if (busy) return
    const normalized = normalize(backendBaseUrl)
    if (!normalized) {
      setResult({ tone: 'warning', message: t('server.urlEmpty') })
      return
    }
    try {
      new URL(normalized)
    } catch {
      setResult({
        tone: 'warning',
        message: t('server.urlInvalid'),
      })
      return
    }

    setBusy(true)
    setResult(null)
    try {
      const next = await persistBackendBaseUrl(normalized)
      setBackendBaseUrl(next)
      setSavedBaseUrl(next)
      setEngineDraftDirty(false)
      reconnectProvider()
      // Changing a transcription backend must not change where app updates come from.
    } catch (error) {
      setResult({ tone: 'error', message: t('server.saveFailed'), detail: String(error) })
      setBusy(false)
      return
    }

    try {
      const payload = await probeHealth(normalized)
      setResult(describeHealth(payload, t('server.savedPrefix')))
    } catch (error) {
      const friendly = describeServerError(error, normalize(normalized) !== normalize(defaultBaseUrl))
      setResult({
        tone: 'error',
        message: t('server.savedButUnreachable', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleResetDefault() {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const next = await resetBackendBaseUrl()
      setBackendBaseUrl(next)
      setSavedBaseUrl(next)
      setEngineDraftDirty(false)
      reconnectProvider()
      const payload = await probeHealth(next)
      setResult(describeHealth(payload, t('server.restoredPrefix', { url: next })))
    } catch (error) {
      const friendly = describeServerError(error, false)
      setResult({
        tone: 'error',
        message: t('server.restoredButUnreachable', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold">{t('server.title')}</h2>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            {t('server.desc')}
            <Tooltip
              variant="light"
              content={t('server.help')}
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground transition-colors hover:text-foreground" />
            </Tooltip>
          </p>

          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2">
              <label htmlFor="server-base-url" className="text-sm text-muted-foreground">
                {t('server.title')}
              </label>
              {isDirty && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-strong">
                  {t('server.unsaved')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="server-base-url"
                type="url"
                inputMode="url"
                value={backendBaseUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveAndTest() }}
                placeholder={defaultBaseUrl || 'http://127.0.0.1:8000'}
                className="h-9 min-w-[16rem] flex-1 rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border"
              />
              <Button size="sm" className="h-9 shrink-0" onClick={() => void handleSaveAndTest()} disabled={busy}>
                {busy ? t('server.savingAndTesting') : t('server.saveAndTest')}
              </Button>
              {isCustom && (
                <Button size="sm" variant="ghost" className="h-9 shrink-0" onClick={() => void handleResetDefault()} disabled={busy}>
                  {t('server.restoreDefault')}
                </Button>
              )}
            </div>
          </div>

          {result && (
            <Feedback
              className="mt-3"
              tone={result.tone}
              message={result.message}
              detail={result.detail}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id="server-language-heading" className="text-lg font-semibold">{t('server.languageTitle')}</h2>
              <p className="mt-2 text-xs text-muted-foreground">{t('server.languageNote')}</p>
            </div>
            <Segmented
              labelledBy="server-language-heading"
              value={asrLanguage}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'zh', label: t('local.lang.zh') },
                { value: 'en', label: t('local.lang.en') },
              ]}
              onChange={(value) => { setAsrLanguage(value); void setSetting('server.language', value) }}
              className="shrink-0 justify-end"
            />
          </div>
        </CardContent>
      </Card>
    </>
  )
}
