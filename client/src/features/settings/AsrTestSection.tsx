
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Pause } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/ui/feedback'
import { getSetting } from '@/services/store'
import { getEngineDraftDirty, subscribeEngineDraft } from '@/stores/engineDraft'
import { buildAsrExtra, resolveAsrDisplayModel } from '@/lib/asrModels'
import { describeProviderError } from '@/lib/errorMessages'
import type { WorkMode } from '@/services/transcription'
import { useT } from '@/i18n/useT'

interface TestResult {
  text: string
  asrMs: number
  mode: WorkMode
  model: string
  audioDurationSec: number
}

interface TestError {
  message: string
  detail?: string
}

export default function AsrTestSection({ workMode }: { workMode: WorkMode }) {
  const t = useT()
  const [testing, setTesting] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [error, setError] = useState<TestError | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const draftDirty = useSyncExternalStore(subscribeEngineDraft, getEngineDraftDirty)

  useEffect(() => {
    setResult(null)
    setError(null)
  }, [workMode])

  async function handlePlay() {
    if (playing && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setPlaying(false)
      return
    }
    try {
      const b64 = await invoke<string>('get_test_audio_b64')
      const audio = new Audio(`data:audio/wav;base64,${b64}`)
      audioRef.current = audio
      audio.onended = () => setPlaying(false)
      setPlaying(true)
      await audio.play()
    } catch {
      setPlaying(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setResult(null)
    setError(null)

    try {
      const wavB64 = await invoke<string>('get_test_audio_b64')
      const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))
      const pcmBytes = wavBytes.slice(44)
      const audioDurationSec = pcmBytes.length / 2 / 16000

      if (workMode === 'local') {
        const modelId = await getSetting('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf') as string
        const language = await getSetting('localAsr.language', 'auto') as string
        const r = await invoke<{ text: string; elapsed_ms: number; model_id: string }>('run_asr_benchmark', {
          modelId, language,
        })
        setResult({ text: r.text, asrMs: r.elapsed_ms, mode: 'local', model: r.model_id, audioDurationSec })
      } else if (workMode === 'cloud_api') {
        let pcmB64 = ''
        const chunk = 8192
        for (let i = 0; i < pcmBytes.length; i += chunk) {
          const slice = pcmBytes.subarray(i, Math.min(i + chunk, pcmBytes.length))
          pcmB64 += String.fromCharCode(...slice)
        }
        pcmB64 = btoa(pcmB64)

        const asrProvider = await getSetting('cloudAsr.provider', 'openai_compat') as string
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string
        const asrModel = await getSetting('cloudAsr.model', '') as string

        const baseUrl = await getSetting('cloudAsr.baseUrl', '') as string
        const protocol = await getSetting('cloudAsr.protocol', 'auto') as string
        const systemInstruction = asrProvider === 'openai_compat'
          ? await getSetting('cloudAsr.systemInstruction', '') as string : ''
        const userPrompt = asrProvider === 'openai_compat'
          ? await getSetting('cloudAsr.userPrompt', '') as string : ''
        const audioEncoding = asrProvider === 'openai_compat'
          ? await getSetting('cloudAsr.audioEncoding', 'wav') as string : 'wav'
        const extra = buildAsrExtra(asrProvider, {
          model: asrModel,
          instructions: systemInstruction,
          userPrompt,
          audioEncoding,
          baseUrl,
          protocol,
        })

        const start = performance.now()
        const r = await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
          request: {
            audio_b64: pcmB64,
            sample_rate: 16000,
            asr_config: {
              provider: asrProvider,
              api_key: asrApiKey,
              app_id: asrAppId,
              ...(extra && { extra }),
            },
          },
        })
        const totalMs = Math.round(performance.now() - start)
        setResult({
          text: r.text,
          asrMs: totalMs,
          mode: 'cloud_api',
          model: extra?.model || resolveAsrDisplayModel(asrProvider),
          audioDurationSec,
        })
      }
    } catch (err) {
      const friendly = describeProviderError(err)
      setError({ message: friendly.message, detail: friendly.detail })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('asrTest.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('asrTest.desc')}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void handlePlay()}>
              {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {playing ? t('asrTest.pause') : t('asrTest.play')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleTest()}
              disabled={testing || draftDirty}
            >
              {testing ? t('asrTest.testing') : t('asrTest.start')}
            </Button>
          </div>
        </div>

        {draftDirty && (
          <Feedback
            className="mt-4"
            tone="warning"
            message={t('asrTest.unsavedWarning')}
          />
        )}

        {error && (
          <Feedback
            className="mt-4"
            tone="error"
            message={t('asrTest.failed', { message: error.message })}
            detail={error.detail}
            actions={[{ label: t('common.retry'), onClick: () => void handleTest(), disabled: testing }]}
          />
        )}

        {result && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="rounded bg-primary/10 px-2 py-0.5 text-primary">
                {t(result.mode === 'local' ? 'asrTest.modeLocal' : 'asrTest.modeCloudApi')}
              </span>
              <span className="rounded bg-muted px-2 py-0.5">{result.model}</span>
              <span>{t('asrTest.audioLen', { sec: result.audioDurationSec.toFixed(1) })}</span>
              <span>{t('asrTest.elapsed', { ms: result.asrMs })}</span>
            </div>
            <p className="mt-2 text-sm text-foreground">{result.text || t('asrTest.noResult')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
