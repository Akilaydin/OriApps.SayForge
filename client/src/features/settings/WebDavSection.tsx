//
//
//
//
//

import { useEffect, useState } from 'react'
import { CloudUpload, Loader2, RotateCcw, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { FormatHint } from '@/components/ui/feedback'
import { getSetting, setSetting } from '@/services/store'
import { restartApp } from '@/services/backup'
import {
  describeWebDavError,
  listWebDavBackups,
  onWebDavBackupProgress,
  restoreWebDavBackup,
  testWebDavConnection,
  DEFAULT_DAV_URL,
  type WebDavEntry,
  type WebDavLastResult,
  type WebDavProgress,
} from '@/services/webdavBackup'
import {
  onWebDavBackupChange,
  refreshLastResult,
  runBackupNow,
} from '@/features/backup/autoWebdavBackup'
import { formatBytes } from '@/lib/utils'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const inputClass =
  'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'

const cardIconButtonClass =
  'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

const phaseLabelKeys: Record<WebDavProgress['phase'], TranslationKey> = {
  preparing: 'backup.status.preparing',
  packingData: 'backup.status.packingData',
  packingAudio: 'backup.status.packingAudio',
  finalizing: 'backup.status.finalizing',
  uploading: 'webdav.status.uploading',
  verifying: 'webdav.status.verifying',
  completed: 'backup.status.completed',
  failed: 'backup.status.failed',
}

const intervalOptions = [
  { value: 24, labelKey: 'webdav.interval.daily' },
  { value: 72, labelKey: 'webdav.interval.every3Days' },
  { value: 168, labelKey: 'webdav.interval.weekly' },
] as const satisfies readonly { value: number; labelKey: TranslationKey }[]

const contentSummaryKeys: Record<string, TranslationKey> = {
  'false,false': 'webdav.summary.config',
  'true,false': 'webdav.summary.configHistory',
  'false,true': 'webdav.summary.configAudio',
  'true,true': 'webdav.summary.all',
}

type Busy = 'test' | 'list' | 'restore' | null

function shortServer(url: string): string {
  return url.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '')
}

function shortTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function WebDavSection() {
  const t = useT()

  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  const [enabled, setEnabled] = useState(false)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [includeHistory, setIncludeHistory] = useState(false)
  const [includeAudio, setIncludeAudio] = useState(false)
  const [intervalHours, setIntervalHours] = useState(24)
  const [keepCount, setKeepCount] = useState(5)

  const [busy, setBusy] = useState<Busy>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<WebDavProgress | null>(null)
  const [lastResult, setLastResult] = useState<WebDavLastResult | null>(null)
  const [testMessage, setTestMessage] = useState('')
  const [actionError, setActionError] = useState('')

  const [serverOpen, setServerOpen] = useState(false)
  const [restoreList, setRestoreList] = useState<WebDavEntry[] | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<WebDavEntry | null>(null)
  const [restoreDone, setRestoreDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [en, u, name, pass, hist, audio, interval, keep] = await Promise.all([
        getSetting('webdav.enabled', false).catch(() => false),
        getSetting('webdav.url', '').catch(() => ''),
        getSetting('webdav.username', '').catch(() => ''),
        getSetting('webdav.password', '').catch(() => ''),
        getSetting('webdav.includeHistory', false).catch(() => false),
        getSetting('webdav.includeAudio', false).catch(() => false),
        getSetting('webdav.intervalHours', 24).catch(() => 24),
        getSetting('webdav.keepCount', 5).catch(() => 5),
      ])
      if (cancelled) return
      setEnabled(en)
      if (u.trim()) {
        setUrl(u)
      } else {
        setUrl(DEFAULT_DAV_URL)
        await setSetting('webdav.url', DEFAULT_DAV_URL).catch(() => undefined)
      }
      setUsername(name)
      setPassword(pass)
      setIncludeHistory(hist)
      setIncludeAudio(audio)
      if (interval === 24 || interval === 72 || interval === 168) setIntervalHours(interval)
      if (keep === 3 || keep === 5 || keep === 10) setKeepCount(keep)
      setLastResult(await refreshLastResult())
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) setAnimate(true) }))
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const unlisten = onWebDavBackupProgress(setProgress)
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  useEffect(() => {
    const off = onWebDavBackupChange((state) => {
      setRunning(state.running)
      setLastResult(state.lastResult)
    })
    return off
  }, [])

  const configured = Boolean(url.trim() && username.trim() && password)
  const isBusy = busy !== null || running

  const urlWarning = (() => {
    const value = url.trim().toLowerCase()
    if (!value) return null
    if (value.startsWith('http://')) return t('webdav.error.urlInsecure')
    if (!value.startsWith('https://')) return t('webdav.error.urlScheme')
    return null
  })()

  const patch = async <T,>(key: string, value: T, apply: (value: T) => void) => {
    apply(value)
    await setSetting(key, value)
  }

  const closeServerDialog = () => {
    setServerOpen(false)
    setTestMessage('')
    setActionError('')
  }

  const handleTest = async () => {
    setBusy('test')
    setTestMessage('')
    setActionError('')
    try {
      const count = await testWebDavConnection({ url, username, password })
      setTestMessage(t('webdav.testOk', { count }))
    } catch (error) {
      setActionError(describeWebDavError(error))
    } finally {
      setBusy(null)
    }
  }

  const handleOpenRestore = async () => {
    setBusy('list')
    setActionError('')
    try {
      setRestoreList(await listWebDavBackups())
    } catch (error) {
      setActionError(describeWebDavError(error))
    } finally {
      setBusy(null)
    }
  }

  const handleRestore = async () => {
    if (!restoreTarget) return
    const name = restoreTarget.name
    setRestoreTarget(null)
    setRestoreList(null)
    setBusy('restore')
    setActionError('')
    try {
      await restoreWebDavBackup(name)
      setRestoreDone(true)
      setTimeout(() => { void restartApp() }, 1500)
    } catch (error) {
      setActionError(describeWebDavError(error))
      setBusy(null)
    }
  }

  const uploading = progress?.status === 'running'
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0))
  const contentSummary = t(contentSummaryKeys[`${includeHistory},${includeAudio}`])
  const intervalLabel = t(
    intervalOptions.find((opt) => opt.value === intervalHours)?.labelKey ?? 'webdav.interval.daily',
  )

  const chip = uploading
    ? { text: `${Math.round(percent)}%`, box: 'bg-warning/10 text-warning-strong' }
    : lastResult?.ok
      ? { text: t('webdav.state.ok'), box: 'bg-success/10 text-success-strong' }
      : lastResult
        ? { text: t('webdav.state.failed'), box: 'bg-destructive/10 text-destructive-strong' }
        : { text: t('webdav.state.never'), box: 'bg-muted text-muted-foreground' }

  const metaParts = [contentSummary]
  if (enabled) metaParts.push(intervalLabel)
  if (lastResult) metaParts.push(shortTime(lastResult.at))
  if (lastResult?.ok) metaParts.push(formatBytes(lastResult.bytes))

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('webdav.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('webdav.desc')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {configured ? (
              <>
                <span className="text-sm text-muted-foreground" id="webdav-enabled-label">
                  {t('webdav.autoLabel')}
                </span>
                <Switch
                  checked={enabled}
                  labelledBy="webdav-enabled-label"
                  onChange={() => void patch('webdav.enabled', !enabled, setEnabled)}
                  noAnimation={!animate}
                  hidden={!ready}
                />
              </>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setServerOpen(true)}>
                <Settings2 className="h-4 w-4" />
                {t('webdav.configure')}
              </Button>
            )}
          </div>
        </div>

        {configured && (
          <>
            <div
              className={cn(
                'mt-4 rounded-lg border p-3',
                enabled ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={url}>
                  {shortServer(url)}
                </span>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                    chip.box,
                  )}
                >
                  {chip.text}
                </span>
              </div>

              <div className="mt-1 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {uploading && progress ? t(phaseLabelKeys[progress.phase]) : metaParts.join(' · ')}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Tooltip content={running ? t('webdav.backingUp') : t('webdav.backupNow')}>
                    <button
                      type="button"
                      onClick={() => void runBackupNow('manual')}
                      disabled={isBusy}
                      aria-label={running ? t('webdav.backingUp') : t('webdav.backupNow')}
                      className={cardIconButtonClass}
                    >
                      {running
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        : <CloudUpload className="h-3.5 w-3.5" aria-hidden />}
                    </button>
                  </Tooltip>
                  <Tooltip content={t('webdav.restore')}>
                    <button
                      type="button"
                      onClick={() => void handleOpenRestore()}
                      disabled={isBusy}
                      aria-label={t('webdav.restore')}
                      className={cardIconButtonClass}
                    >
                      {busy === 'list' || busy === 'restore'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                    </button>
                  </Tooltip>
                  <Tooltip content={t('webdav.settings')}>
                    <button
                      type="button"
                      onClick={() => setServerOpen(true)}
                      aria-label={t('webdav.settings')}
                      className={cardIconButtonClass}
                    >
                      <Settings2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {uploading && progress && (
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={t('webdav.progressAria')}
                  aria-valuenow={Math.round(percent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}

              {!uploading && lastResult && !lastResult.ok && (
                <p className="mt-1.5 text-[11px] text-destructive">
                  {describeWebDavError(lastResult.error ?? '')}
                </p>
              )}

              {actionError && <p className="mt-1.5 text-[11px] text-destructive">{actionError}</p>}
            </div>
          </>
        )}
      </CardContent>

      {serverOpen && (
        <Modal
          title={t('webdav.settingsTitle')}
          onClose={closeServerDialog}
          showCloseButton
          panelClassName="w-[520px]"
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="webdav-url" className="mb-1 block text-sm text-muted-foreground">
                {t('webdav.url')}
              </label>
              <input
                id="webdav-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => void patch('webdav.url', e.target.value, setUrl)}
                placeholder={DEFAULT_DAV_URL}
                className={inputClass}
              />
              {urlWarning
                ? <FormatHint text={urlWarning} />
                : <p className="mt-1 text-[11px] text-muted-foreground">{t('webdav.urlHint')}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="webdav-username" className="mb-1 block text-sm text-muted-foreground">
                  {t('webdav.username')}
                </label>
                <input
                  id="webdav-username"
                  type="text"
                  autoComplete="off"
                  value={username}
                  onChange={(e) => void patch('webdav.username', e.target.value, setUsername)}
                  className={inputClass}
                />
              </div>
              <div data-modal-autofocus>
                <label htmlFor="webdav-password" className="mb-1 block text-sm text-muted-foreground">
                  {t('webdav.password')}
                </label>
                <PasswordInput
                  id="webdav-password"
                  label={t('webdav.password')}
                  value={password}
                  onChange={(value) => void patch('webdav.password', value, setPassword)}
                  onSubmit={() => void handleTest()}
                  className={inputClass}
                />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">{t('webdav.jianguoyunHint')}</p>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm font-medium">{t('webdav.contentTitle')}</p>

            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm">{t('webdav.includeConfig')}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t('webdav.always')}</span>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-sm" id="webdav-history-label">{t('webdav.includeHistory')}</label>
              <Switch
                checked={includeHistory}
                labelledBy="webdav-history-label"
                onChange={() => void patch('webdav.includeHistory', !includeHistory, setIncludeHistory)}
                noAnimation={!animate}
              />
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-sm" id="webdav-audio-label">{t('webdav.includeAudio')}</label>
              <Switch
                checked={includeAudio}
                labelledBy="webdav-audio-label"
                onChange={() => void patch('webdav.includeAudio', !includeAudio, setIncludeAudio)}
                noAnimation={!animate}
              />
            </div>
            {includeAudio && <FormatHint text={t('webdav.audioOnHint')} />}
          </div>

          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label className="text-sm text-muted-foreground">{t('webdav.intervalLabel')}</label>
              <Segmented
                label={t('webdav.intervalLabel')}
                value={intervalHours}
                options={intervalOptions.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                onChange={(value) => void patch('webdav.intervalHours', value, setIntervalHours)}
                className="shrink-0 justify-end"
              />
            </div>
            <div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <label className="text-sm text-muted-foreground">{t('webdav.keepLabel')}</label>
                <Segmented
                  label={t('webdav.keepLabel')}
                  value={keepCount}
                  options={[3, 5, 10].map((value) => ({ value, label: String(value) }))}
                  onChange={(value) => void patch('webdav.keepCount', value, setKeepCount)}
                  className="shrink-0 justify-end"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t('webdav.keepHint')}</p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <span className={`min-w-0 flex-1 text-xs ${actionError ? 'text-destructive' : 'text-success-strong'}`}>
              {actionError || testMessage}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => void handleTest()}
              disabled={busy === 'test' || !configured}
            >
              {busy === 'test' && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('webdav.test')}
            </Button>
            <Button size="sm" className="shrink-0" onClick={closeServerDialog}>
              {t('webdav.done')}
            </Button>
          </div>
        </Modal>
      )}

      {restoreList && (
        <Modal title={t('webdav.restoreTitle')} onClose={() => setRestoreList(null)} panelClassName="w-[460px]">
          {restoreList.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('webdav.restoreEmpty')}</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {restoreList.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => setRestoreTarget(entry)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span className="min-w-0 truncate">{entry.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(entry.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setRestoreList(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Modal>
      )}

      {restoreTarget && (
        <Modal title={t('webdav.restoreConfirmTitle')} onClose={() => setRestoreTarget(null)} showCloseButton={false}>
          <p className="text-sm text-muted-foreground">
            {t('webdav.restoreConfirmBody', { name: restoreTarget.name })}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRestoreTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleRestore()}>
              {t('webdav.restoreConfirmOk')}
            </Button>
          </div>
        </Modal>
      )}

      {restoreDone && (
        <Modal title={t('webdav.restoreDoneTitle')} onClose={() => undefined} locked showCloseButton={false}>
          <p className="text-sm text-muted-foreground">{t('webdav.restoreDoneBody')}</p>
        </Modal>
      )}
    </Card>
  )
}
