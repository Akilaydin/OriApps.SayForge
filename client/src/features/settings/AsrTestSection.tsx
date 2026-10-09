
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Pause } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/ui/feedback'
import { loadAsrConfig } from '@/services/transcription/asrConfig'
import { prepareTestPcm, testCloudAsr } from '@/services/transcription/asrTest'
import { getEngineDraftDirty, subscribeEngineDraft } from '@/stores/engineDraft'
import { resolveAsrDisplayModel } from '@/lib/asrModels'
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

  const mounted = useRef(false)
  const testBusy = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++; audioRef.current?.pause() }
  }, [])

  const draftDirty = useSyncExternalStore(subscribeEngineDraft, getEngineDraftDirty)

  useEffect(() => {
    generation.current++
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
      if (!mounted.current) return
      const audio = new Audio(`data:audio/wav;base64,${b64}`)
      audioRef.current = audio
      audio.onended = () => { if (mounted.current) setPlaying(false) }
      setPlaying(true)
      await audio.play()
    } catch {
      if (mounted.current) setPlaying(false)
    }
  }

  async function handleTest() {
    if (testBusy.current || draftDirty) return
    testBusy.current = true
    const run = ++generation.current
    const current = () => mounted.current && generation.current === run
    setTesting(true)
    setResult(null)
    setError(null)

    try {
      if (workMode === 'cloud_api') {
        const config = await loadAsrConfig()
        const audio = await prepareTestPcm()
        if (!current()) return
        const r = await testCloudAsr(config, audio)
        if (!current()) return
        setResult({
          text: r.text, asrMs: r.latencyMs, mode: 'cloud_api',
          model: String(config.extra?.model || resolveAsrDisplayModel(config.provider)),
          audioDurationSec: r.audioSec,
        })
      }
    } catch (err) {
      if (!current()) return
      const friendly = describeProviderError(err)
      setError({ message: friendly.message, detail: friendly.detail })
    } finally {
      testBusy.current = false
      if (mounted.current) setTesting(false)
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
                {t('asrTest.modeCloudApi')}
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
