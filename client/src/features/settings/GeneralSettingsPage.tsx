
import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { createMicrophoneDigitalGain, listMicrophones, microphoneCaptureConstraints, normalizeSelectedMicId } from '@/services/audio'
import {
  DEFAULT_MIC_GAIN_DB,
  DEFAULT_MIC_GAIN_ENABLED,
  microphoneGainMultiplier,
  normalizeMicGainDb,
  type MicGainSettings,
} from '@/services/micGain'
import { refreshRecorderSettings } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import { getDefault } from '@/services/defaults'
import { drawBars, resetWaveform } from '@/services/waveform'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import AppSection from './AppSection'
import BackupSection from './BackupSection'
import MicrophoneSection from './MicrophoneSection'
import type { MicVolumeLevel } from './MicrophoneSection'
import { ComboShortcutInput, PTTShortcutInput } from './ShortcutInputs'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'
import { t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { MIC_LOW_RMS_THRESHOLD } from '@/services/recorder/helpers'
import { runAction } from '@/services/actionFeedback'
import { SaveStatus, useActionPending } from '@/components/ActionFeedback'

function ShortcutLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <Tooltip variant="light" content={help}>
        <Info
          aria-label={t('settings.helpAria', { label })}
          className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        />
      </Tooltip>
    </span>
  )
}

export default function GeneralSettingsPage() {
  const t = useT()
  const savePending = useActionPending('general-settings')
  const saveChange = (operation: () => Promise<unknown>) => runAction('general-settings', operation, { error: t('feedback.applyFailed') })
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoLaunchReady, setAutoLaunchReady] = useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false)
  const [autoLaunchError, setAutoLaunchError] = useState('')
  const launchBusy = useRef(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [micGainEnabled, setMicGainEnabled] = useState(DEFAULT_MIC_GAIN_ENABLED)
  const [micGainDb, setMicGainDb] = useState(DEFAULT_MIC_GAIN_DB)
  const [micGainSaving, setMicGainSaving] = useState(false)
  const [micGainError, setMicGainError] = useState('')
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [muteSystemAudio, setMuteSystemAudio] = useState(false)
  const [protectClipboard, setProtectClipboard] = useState(true)
  const [pttKey, setPttKey] = useState(() => getDefault<string>('shortcutPTT', ''))
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)
  const testMicGainNodeRef = useRef<GainNode | null>(null)
  const liveMicGain = useRef<MicGainSettings>({ enabled: DEFAULT_MIC_GAIN_ENABLED, db: DEFAULT_MIC_GAIN_DB })
  const micGainWriteBusy = useRef(false)
  const savedMicGainDb = useRef(DEFAULT_MIC_GAIN_DB)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [launch, mute, clip, history, readySound, logDays, gainEnabled, gainDb] = await Promise.all([
        bridge.getAutoLaunch().catch(() => null),
        getSetting('muteSystemAudioWhileRecording', false).catch(() => false),
        getSetting('protectClipboard', true).catch(() => true),
        getSetting('historyEnabled', true).catch(() => true),
        getSetting('readySoundEnabled', true).catch(() => true),
        getSetting('logRetentionDays', 30).catch(() => 30),
        getSetting('micGainEnabled', DEFAULT_MIC_GAIN_ENABLED).catch(() => DEFAULT_MIC_GAIN_ENABLED),
        getSetting('micGainDb', DEFAULT_MIC_GAIN_DB).catch(() => DEFAULT_MIC_GAIN_DB),
      ])
      if (cancelled) return
      setAutoLaunch(Boolean(launch))
      setAutoLaunchReady(launch !== null)
      if (launch === null) setAutoLaunchError(t('settings.app.autoLaunchReadFailed'))
      setMuteSystemAudio(Boolean(mute))
      setProtectClipboard(Boolean(clip))
      setHistoryEnabled(Boolean(history))
      setReadySoundEnabled(Boolean(readySound))
      const ld = Number(logDays)
      if (ld === 7 || ld === 15 || ld === 30 || ld === 90) setLogRetentionDays(ld)
      setMicGainEnabled(gainEnabled === true)
      const normalizedGainDb = normalizeMicGainDb(gainDb)
      setMicGainDb(normalizedGainDb)
      savedMicGainDb.current = normalizedGainDb
      liveMicGain.current = { enabled: gainEnabled === true, db: normalizedGainDb }
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()
    getSetting('selectedMic', '').then(async (raw) => {
      if (cancelled) return
      const normalized = normalizeSelectedMicId(raw)
      setSelectedMic(normalized)
      if (typeof raw === 'string' && raw !== normalized) {
        await setSetting('selectedMic', normalized)
        await refreshRecorderSettings()
      }
    }).catch(() => { })
    getSetting<string>('shortcutPTT').then((value) => setPttKey(value))
    getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string))
    listMicrophones().then(setMics).catch(() => { })
    return () => { cancelled = true }
  }, [])

  const retryAutoLaunch = async () => {
    if (launchBusy.current) return
    launchBusy.current = true; setAutoLaunchBusy(true)
    try {
      setAutoLaunch(await bridge.getAutoLaunch()); setAutoLaunchReady(true); setAutoLaunchError('')
    } catch { setAutoLaunchReady(false); setAutoLaunchError(t('settings.app.autoLaunchReadFailed')) }
    finally { launchBusy.current = false; setAutoLaunchBusy(false) }
  }
  const toggleAutoLaunch = async () => {
    if (launchBusy.current || !autoLaunchReady) return
    launchBusy.current = true; setAutoLaunchBusy(true); setAutoLaunchError('')
    try { setAutoLaunch(await bridge.setAutoLaunchVerified(!autoLaunch)) }
    catch {
      setAutoLaunchError(t('settings.app.autoLaunchChangeFailed'))
      try { setAutoLaunch(await bridge.getAutoLaunch()) }
      catch { setAutoLaunchReady(false) }
    } finally { launchBusy.current = false; setAutoLaunchBusy(false) }
  }
  const handleMicChange = async (deviceId: string) => { await saveChange(async () => { setSelectedMic(deviceId); await setSetting('selectedMic', deviceId); await refreshRecorderSettings() }) }
  const updateTestMicGain = (enabled: boolean, db: number) => {
    liveMicGain.current = { enabled, db }
    if (testMicGainNodeRef.current) {
      testMicGainNodeRef.current.gain.value = microphoneGainMultiplier(liveMicGain.current)
    }
  }
  const toggleMicGain = async () => {
    if (micGainWriteBusy.current || !ready) return
    micGainWriteBusy.current = true
    setMicGainSaving(true)
    setMicGainError('')
    const next = !micGainEnabled
    setMicGainEnabled(next)
    updateTestMicGain(next, micGainDb)
    let persisted = false
    try {
      await setSetting('micGainEnabled', next)
      persisted = true
      await refreshRecorderSettings()
    } catch {
      if (!persisted) {
        setMicGainEnabled(!next)
        updateTestMicGain(!next, micGainDb)
      }
      setMicGainError(t(persisted ? 'mic.gain.applyFailed' : 'mic.gain.saveFailed'))
    } finally {
      micGainWriteBusy.current = false
      setMicGainSaving(false)
    }
  }
  const changeMicGainDb = (value: number) => {
    const next = normalizeMicGainDb(value)
    setMicGainDb(next)
    updateTestMicGain(micGainEnabled, next)
  }
  const commitMicGainDb = async (value: number) => {
    if (micGainWriteBusy.current || !ready) return
    const next = normalizeMicGainDb(value)
    if (next === savedMicGainDb.current) return
    micGainWriteBusy.current = true
    setMicGainSaving(true)
    setMicGainError('')
    let persisted = false
    try {
      await setSetting('micGainDb', next)
      savedMicGainDb.current = next
      persisted = true
      await refreshRecorderSettings()
    } catch {
      if (!persisted) {
        setMicGainDb(savedMicGainDb.current)
        updateTestMicGain(micGainEnabled, savedMicGainDb.current)
      }
      setMicGainError(t(persisted ? 'mic.gain.applyFailed' : 'mic.gain.saveFailed'))
    } finally {
      micGainWriteBusy.current = false
      setMicGainSaving(false)
    }
  }
  const toggleMuteSystemAudio = async () => { await saveChange(async () => { const next = !muteSystemAudio; setMuteSystemAudio(next); await setSetting('muteSystemAudioWhileRecording', next); await refreshRecorderSettings() }) }
  const toggleProtectClipboard = async () => { await saveChange(async () => { const next = !protectClipboard; setProtectClipboard(next); await setSetting('protectClipboard', next); await refreshRecorderSettings() }) }
  const toggleHistoryEnabled = async () => { await saveChange(async () => { const next = !historyEnabled; setHistoryEnabled(next); await setSetting('historyEnabled', next) }) }
  const toggleReadySound = async () => { await saveChange(async () => { const next = !readySoundEnabled; setReadySoundEnabled(next); await setSetting('readySoundEnabled', next); await refreshRecorderSettings() }) }
  const handleLogRetentionDaysChange = async (value: number) => { await saveChange(async () => { setLogRetentionDays(value); await setSetting('logRetentionDays', value) }) }
  const handlePTTChange = async (value: string) => { await saveChange(async () => { setPttKey(value); await setSetting('shortcutPTT', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }) }
  const handleHandsFreeChange = async (value: string) => { await saveChange(async () => { setHandsFreeKey(value); await setSetting('shortcutHandsFree', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }) }

  const validatePTT = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(value, handsFreeKey)) {
      return t('settings.shortcuts.conflictHandsFree')
    }
    return null
  }, [handsFreeKey])
  const validateHandsFree = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(pttKey, value)) {
      return t('settings.shortcuts.conflictPtt')
    }
    return null
  }, [pttKey])

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current; if (!canvas) return
    const context = canvas.getContext('2d'); if (!context) return
    const draw = () => { drawBars(context, analyser, canvas.width, canvas.height); animRef.current = requestAnimationFrame(draw) }
    draw()
  }, [])

  const testMic = async () => {
    if (testing) return; setTesting(true); setVolumeLevel('idle'); setMicError('')
    try {
      const noiseSuppression = await getSetting('micNoiseSuppression', true).catch(() => true)
      const stream = await navigator.mediaDevices.getUserMedia(
        microphoneCaptureConstraints(selectedMic || undefined, Boolean(noiseSuppression)),
      )
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7
      const gainNode = createMicrophoneDigitalGain(context, source, liveMicGain.current)
      testMicGainNodeRef.current = gainNode
      gainNode.connect(analyser)
      resetWaveform(); drawWaveform(analyser)

      const dataArray = new Float32Array(analyser.frequencyBinCount)
      let peakRms = 0
      let sawNonZeroSignal = false
      const volumeCheckId = setInterval(() => {
        analyser.getFloatTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = dataArray[i]
          sum += v * v
          if (v !== 0) sawNonZeroSignal = true
        }
        const rms = Math.sqrt(sum / dataArray.length)
        if (rms > peakRms) peakRms = rms
        if (!sawNonZeroSignal) setVolumeLevel('silent')
        else if (peakRms < MIC_LOW_RMS_THRESHOLD) setVolumeLevel('low')
        else setVolumeLevel('normal')
      }, 500)

      setTimeout(() => {
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        if (testMicGainNodeRef.current === gainNode) testMicGainNodeRef.current = null
        stream.getTracks().forEach((t) => t.stop()); context.close(); setTesting(false)
      }, 5000)
    } catch (err) {
      testMicGainNodeRef.current = null
      const msg = err instanceof DOMException && err.name === 'NotFoundError'
        ? t('mic.error.notFound')
        : err instanceof DOMException && err.name === 'NotAllowedError'
          ? t('mic.error.denied')
          : t('mic.error.failed')
      setMicError(msg)
      setTesting(false); setVolumeLevel('idle')
    }
  }

  return (
    <fieldset disabled={savePending || !ready} className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">{t('settings.title')}</h1>
      <SaveStatus actionKey="general-settings" />
      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold">{t('settings.shortcuts.title')}</h2>
            <p className="mb-4 mt-1 text-xs text-muted-foreground">
              {t('settings.shortcuts.escHint')}
            </p>
            <div className="space-y-4">
              <ComboShortcutInput
                value={handsFreeKey}
                onChange={handleHandsFreeChange}
                validate={validateHandsFree}
                label={<ShortcutLabel label={t('settings.shortcuts.handsFree')} help={t('settings.shortcuts.handsFreeHelp')} />}
                description={t('settings.shortcuts.handsFreeDesc')}
              />
              <PTTShortcutInput
                value={pttKey}
                onChange={handlePTTChange}
                validate={validatePTT}
                label={<ShortcutLabel label={t('settings.shortcuts.ptt')} help={t('settings.shortcuts.pttHelp')} />}
                description={t('settings.shortcuts.pttDesc')}
              />
            </div>
          </CardContent>
        </Card>

        <MicrophoneSection mics={mics} selectedMic={selectedMic} testing={testing} volumeLevel={volumeLevel}
          gainEnabled={micGainEnabled} gainDb={micGainDb} gainReady={ready} gainSaving={micGainSaving}
          gainSaveError={micGainError} onGainEnabledToggle={() => void toggleMicGain()}
          onGainDbChange={changeMicGainDb} onGainDbCommit={(value) => void commitMicGainDb(value)}
          onCanvasRef={(node) => { canvasRef.current = node }} onMicChange={handleMicChange} onTestMic={testMic} errorMessage={micError} />

        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">{t('settings.prefs.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{t('settings.prefs.readySound')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.readySoundDesc')}</p>
              </div>
              <Switch checked={readySoundEnabled} onChange={() => void toggleReadySound()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">{t('settings.prefs.muteSystemAudio')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.muteSystemAudioDesc')}</p>
              </div>
              <Switch checked={muteSystemAudio} onChange={() => void toggleMuteSystemAudio()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">{t('settings.prefs.protectClipboard')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.protectClipboardDesc')}</p>
              </div>
              <Switch checked={protectClipboard} onChange={() => void toggleProtectClipboard()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        <AppSection autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} ready={ready && autoLaunchReady} animate={animate} busy={autoLaunchBusy} error={autoLaunchError} onRetry={() => void retryAutoLaunch()} />

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t('settings.history.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.history.desc')}</p>
              </div>
              <Switch checked={historyEnabled} onChange={() => void toggleHistoryEnabled()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('settings.log.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.log.desc')}</p>
              </div>
              <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
                <Segmented
                  label={t('settings.log.title')}
                  value={logRetentionDays}
                  options={([{ value: 7, labelKey: 'settings.retention.7d' }, { value: 15, labelKey: 'settings.retention.15d' }, { value: 30, labelKey: 'settings.retention.1m' }, { value: 90, labelKey: 'settings.retention.3m' }] as const satisfies readonly { value: number; labelKey: TranslationKey }[]).map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                  onChange={(value) => void handleLogRetentionDaysChange(value)}
                  animated={animate}
                  className="justify-end"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <BackupSection />
      </div>
    </fieldset>
  )
}
