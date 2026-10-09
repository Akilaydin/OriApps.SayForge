
import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Info, Pencil, RotateCcw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { Tooltip } from '@/components/ui/tooltip'
import { listMicrophones, normalizeSelectedMicId } from '@/services/audio'
import { refreshRecorderSettings } from '@/services/recorder'
import { getPresetShortcuts, getSetting, setSetting } from '@/services/store'
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
import {
  CONTEXT_SELECTION_EDIT_PROMPT,
  CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY,
  normalizeContextSelectionEditPrompt,
} from '@/services/contextAware'

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
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [muteSystemAudio, setMuteSystemAudio] = useState(false)
  const [protectClipboard, setProtectClipboard] = useState(true)
  const [contextAwareWriting, setContextAwareWriting] = useState(false)
  const [contextPromptOpen, setContextPromptOpen] = useState(false)
  const [contextSelectionEditPrompt, setContextSelectionEditPrompt] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [contextPromptDraft, setContextPromptDraft] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [contextPromptSaving, setContextPromptSaving] = useState(false)
  const [pttKey, setPttKey] = useState(() => getDefault<string>('shortcutPTT', ''))
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [aiToggleKey, setAiToggleKey] = useState('')
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [audioRetentionEnabled, setAudioRetentionEnabled] = useState(true)
  const [audioRetentionDays, setAudioRetentionDays] = useState(30)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [launch, mute, clip, contextAware, history, retention, readySound, audioDays, logDays] = await Promise.all([
        bridge.getAutoLaunch().catch(() => false),
        getSetting('muteSystemAudioWhileRecording', false).catch(() => false),
        getSetting('protectClipboard', true).catch(() => true),
        getSetting('contextAwareWritingEnabled', false).catch(() => false),
        getSetting('historyEnabled', true).catch(() => true),
        getSetting('audioRetentionEnabled', true).catch(() => true),
        getSetting('readySoundEnabled', true).catch(() => true),
        getSetting('audioRetentionDays', -1).catch(() => -1),
        getSetting('logRetentionDays', 30).catch(() => 30),
      ])
      if (cancelled) return
      setAutoLaunch(Boolean(launch))
      setMuteSystemAudio(Boolean(mute))
      setProtectClipboard(Boolean(clip))
      setContextAwareWriting(Boolean(contextAware))
      setHistoryEnabled(Boolean(history))
      setAudioRetentionEnabled(Boolean(retention))
      setReadySoundEnabled(Boolean(readySound))
      const ad = Number(audioDays)
      if (ad === 7 || ad === 30 || ad === 90 || ad === -1) setAudioRetentionDays(ad)
      const ld = Number(logDays)
      if (ld === 7 || ld === 15 || ld === 30 || ld === 90) setLogRetentionDays(ld)
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
    getSetting('shortcutToggleAi', '').then((value) => setAiToggleKey(value as string))
    getSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT)
      .then((value) => {
        const prompt = normalizeContextSelectionEditPrompt(value)
        setContextSelectionEditPrompt(prompt)
        setContextPromptDraft(prompt)
      })
      .catch(() => { })
    listMicrophones().then(setMics).catch(() => { })
    return () => { cancelled = true }
  }, [])

  const toggleAutoLaunch = async () => { const next = !autoLaunch; setAutoLaunch(next); await bridge.setAutoLaunch(next) }
  const handleMicChange = async (deviceId: string) => { setSelectedMic(deviceId); await setSetting('selectedMic', deviceId); await refreshRecorderSettings() }
  const toggleMuteSystemAudio = async () => { const next = !muteSystemAudio; setMuteSystemAudio(next); await setSetting('muteSystemAudioWhileRecording', next); await refreshRecorderSettings() }
  const toggleProtectClipboard = async () => { const next = !protectClipboard; setProtectClipboard(next); await setSetting('protectClipboard', next); await refreshRecorderSettings() }
  const toggleContextAwareWriting = async () => { const next = !contextAwareWriting; setContextAwareWriting(next); await setSetting('contextAwareWritingEnabled', next); await refreshRecorderSettings() }
  const openContextPrompt = () => {
    setContextPromptDraft(contextSelectionEditPrompt)
    setContextPromptOpen(true)
  }
  const saveContextPrompt = async () => {
    const prompt = contextPromptDraft.trim()
    if (!prompt || contextPromptSaving) return
    setContextPromptSaving(true)
    try {
      await setSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, prompt)
      setContextSelectionEditPrompt(prompt)
      await refreshRecorderSettings()
      setContextPromptOpen(false)
    } finally {
      setContextPromptSaving(false)
    }
  }
  const resetContextPrompt = async () => {
    if (contextPromptSaving) return
    setContextPromptSaving(true)
    try {
      await setSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT)
      setContextSelectionEditPrompt(CONTEXT_SELECTION_EDIT_PROMPT)
      setContextPromptDraft(CONTEXT_SELECTION_EDIT_PROMPT)
      await refreshRecorderSettings()
    } finally {
      setContextPromptSaving(false)
    }
  }
  const toggleHistoryEnabled = async () => { const next = !historyEnabled; setHistoryEnabled(next); await setSetting('historyEnabled', next) }
  const toggleAudioRetention = async () => { const next = !audioRetentionEnabled; setAudioRetentionEnabled(next); await setSetting('audioRetentionEnabled', next) }
  const toggleReadySound = async () => { const next = !readySoundEnabled; setReadySoundEnabled(next); await setSetting('readySoundEnabled', next); await refreshRecorderSettings() }
  const handleAudioRetentionDaysChange = async (value: number) => { setAudioRetentionDays(value); await setSetting('audioRetentionDays', value) }
  const handleLogRetentionDaysChange = async (value: number) => { setLogRetentionDays(value); await setSetting('logRetentionDays', value) }
  const handlePTTChange = async (value: string) => { setPttKey(value); await setSetting('shortcutPTT', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }
  const handleHandsFreeChange = async (value: string) => { setHandsFreeKey(value); await setSetting('shortcutHandsFree', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }

  const validatePTT = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(value, handsFreeKey)) {
      return t('settings.shortcuts.conflictHandsFree')
    }
    if (pttShortcutConflictsWithAccelerator(value, aiToggleKey)) {
      return t('settings.shortcuts.conflictAiToggle')
    }
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).some(
      (shortcut) => pttShortcutConflictsWithAccelerator(value, shortcut),
    )) return t('settings.shortcuts.conflictPreset')
    return null
  }, [handsFreeKey, aiToggleKey])
  const validateHandsFree = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(pttKey, value)) {
      return t('settings.shortcuts.conflictPtt')
    }
    if (value === aiToggleKey) return t('settings.shortcuts.conflictAiToggle')
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).includes(value)) return t('settings.shortcuts.conflictPreset')
    return null
  }, [pttKey, aiToggleKey])

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current; if (!canvas) return
    const context = canvas.getContext('2d'); if (!context) return
    const draw = () => { drawBars(context, analyser, canvas.width, canvas.height); animRef.current = requestAnimationFrame(draw) }
    draw()
  }, [])

  const testMic = async () => {
    if (testing) return; setTesting(true); setVolumeLevel('idle'); setMicError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: selectedMic ? { deviceId: { exact: selectedMic } } : true })
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7
      source.connect(analyser); resetWaveform(); drawWaveform(analyser)

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
        else if (peakRms < 0.02) setVolumeLevel('low')
        else setVolumeLevel('normal')
      }, 500)

      setTimeout(() => {
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        stream.getTracks().forEach((t) => t.stop()); context.close(); setTesting(false)
      }, 5000)
    } catch (err) {
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
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">{t('settings.title')}</h1>
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

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-lg font-semibold">{t('settings.contextAware.title')}</h2>
                  <Tooltip
                    variant="light"
                    content={(
                      <div className="w-[32rem] max-w-[calc(100vw-3rem)] space-y-2">
                        <p>{t('settings.contextAware.infoFunction')}</p>
                        <p>{t('settings.contextAware.infoUsage')}</p>
                        <p>{t('settings.contextAware.infoPrinciple')}</p>
                      </div>
                    )}
                  >
                    <Info
                      aria-label={t('settings.contextAware.infoAria')}
                      className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                    />
                  </Tooltip>
                </div>
                <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
                  <p>{t('settings.contextAware.descContinue')}</p>
                  <p>{t('settings.contextAware.descSelection')}</p>
                </div>
                <button
                  type="button"
                  onClick={openContextPrompt}
                  className="mt-2 inline-flex items-center gap-1.5 py-1 text-xs font-medium text-primary transition-colors hover:text-primary/75 hover:underline hover:underline-offset-4"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  {t('settings.contextAware.editPrompt')}
                </button>
              </div>
              <Switch checked={contextAwareWriting} onChange={() => void toggleContextAwareWriting()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        {contextPromptOpen && (
          <Modal
            title={t('settings.contextAware.promptTitle')}
            onClose={() => setContextPromptOpen(false)}
            locked={contextPromptSaving}
            showCloseButton
            panelClassName="w-[720px]"
          >
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t('settings.contextAware.promptDesc')}
            </p>
            <textarea
              value={contextPromptDraft}
              onChange={(event) => setContextPromptDraft(event.target.value)}
              aria-label={t('settings.contextAware.promptEditorAria')}
              spellCheck={false}
              rows={14}
              className="mt-4 w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
            />
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => void resetContextPrompt()}
                disabled={contextPromptSaving || contextPromptDraft === CONTEXT_SELECTION_EDIT_PROMPT}
                className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {t('settings.contextAware.resetPrompt')}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setContextPromptOpen(false)}
                  disabled={contextPromptSaving}
                  className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void saveContextPrompt()}
                  disabled={contextPromptSaving || !contextPromptDraft.trim()}
                  className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {contextPromptSaving ? t('settings.contextAware.savingPrompt') : t('common.save')}
                </button>
              </div>
            </div>
          </Modal>
        )}

        <AppSection autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} ready={ready} animate={animate} />

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
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t('settings.audio.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.audio.desc')}</p>
              </div>
              <Switch checked={audioRetentionEnabled} onChange={() => void toggleAudioRetention()} noAnimation={!animate} hidden={!ready} />
            </div>
            {audioRetentionEnabled && (
              <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <label className="text-sm text-muted-foreground">{t('settings.audio.retentionLabel')}</label>
                <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
                  <Segmented
                    label={t('settings.audio.retentionLabel')}
                    value={audioRetentionDays}
                    options={([{ value: 7, labelKey: 'settings.retention.7d' }, { value: 30, labelKey: 'settings.retention.1m' }, { value: 90, labelKey: 'settings.retention.3m' }, { value: -1, labelKey: 'settings.retention.forever' }] as const satisfies readonly { value: number; labelKey: TranslationKey }[]).map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                    onChange={(value) => void handleAudioRetentionDaysChange(value)}
                    animated={animate}
                    className="justify-end"
                  />
                </div>
              </div>
            )}
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
    </div>
  )
}
