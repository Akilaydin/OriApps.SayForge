
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Copy, Check, ChevronDown, HardDrive, Loader2, Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Feedback } from '@/components/ui/feedback'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { getSetting, setSetting } from '@/services/store'
import { refreshModeStatus } from '@/stores/modeStatus'
import { reconnectProvider } from '@/services/recorder'
import { describeDownloadError } from '@/lib/errorMessages'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'
import {
  localModelDisplayDescription,
  localModelDisplayLanguages,
  localModelDisplayName,
} from '@/i18n/displayNames'

const MODELS_DIR_CHANGED_EVENT = 'sayforge:models-dir-changed'

function formatList(items: string[]): string {
  return items.join(t('common.listSeparator'))
}

interface ModelFile {
  name: string
  url: string
  size_bytes: number
  sha256: string | null
}

interface DownloadSource {
  source: string
  files: ModelFile[]
}

interface ModelInfo {
  id: string
  name: string
  description: string
  model_type: string
  total_size_bytes: number
  languages: string[]
  sources: DownloadSource[]
  archive_url?: string
  speed?: number
  accuracy?: number
  recommended?: boolean
  memory_mb?: number
  languages_label?: string
  quant?: string
  featured?: boolean
}

interface LocalModelInfo {
  id: string
  name: string
  model_type: string
  total_size_bytes: number
  path: string
  complete: boolean
}

interface DownloadProgress {
  model_id: string
  file_name: string
  downloaded_bytes: number
  total_bytes: number
  percent: number
  file_index: number
  file_count: number
  status: string
  error: string | null
}

interface ModelsDirInfo {
  current: string
  default_dir: string
  is_custom: boolean
}

interface GgufDevice {
  kind: string
  name: string
  memory_mb: number
  id: string
  index: number
  is_gpu: boolean
}

interface GgufDiagnostics {
  devices: GgufDevice[]
  current_backend: string | null
  current_device: string | null
  loading_model: string | null
  native_version: string
  process_memory_mb: number
}

function cleanDeviceName(name: string): string {
  return name.replace(/\((R|TM)\)/gi, '').trim()
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatMemory(mb: number): string {
  if (mb < 1024) return `~${mb} MB`
  return `~${(mb / 1024).toFixed(1)} GB`
}

function sourceLabel(source: string): string {
  return source === 'HuggingFace Mirror' ? t('local.source.mirror') : source
}

function MiniRating({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100))
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{label}</span>
        <Tooltip content={copied ? t('record.copied') : t('common.copyLink')}>
          <button
            type="button"
            aria-label={copied ? t('common.copiedLink', { label }) : t('common.copyLinkAria', { label })}
            onClick={() => {
              void navigator.clipboard.writeText(url)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-success-strong" aria-hidden />
              : <Copy className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </Tooltip>
      </div>
      <code className="mt-1 block select-all break-all text-[11px] leading-relaxed text-muted-foreground">{url}</code>
    </div>
  )
}

function OfflineGuideDialog({ models, onClose }: { models: ModelInfo[]; onClose: () => void }) {
  const [selectedSource, setSelectedSource] = useState(0)

  const sourceNames = models[0]?.sources.map((s) => s.source) || []

  return (
    <Modal title={t('local.offlineGuideTitle')} onClose={onClose} showCloseButton panelClassName="w-[640px]">
      <>
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>{t('local.offlineStep1')}</p>
          <p>{t('local.offlineStep2')}</p>
          <p>{t('local.offlineStep3')}</p>
        </div>

        <div role="radiogroup" aria-label={t('local.downloadSourceAria')} className="mt-4 flex gap-1 rounded-lg border border-border p-0.5">
          {sourceNames.map((name, i) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selectedSource === i}
              onClick={() => setSelectedSource(i)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${selectedSource === i
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {sourceLabel(name)}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {models.map((model) => {
            const modelName = localModelDisplayName(model)
            const source = model.sources[selectedSource] ?? model.sources[0]
            const isArchive = !source && !!model.archive_url
            if (!source && !isArchive) return null
            const archiveUrl = model.archive_url
              ? (model.archive_url.startsWith('https://github.com/')
                ? `https://gh-proxy.com/${model.archive_url}`
                : model.archive_url)
              : ''
            return (
              <div key={model.id}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-medium">{modelName}</span>
                  <code className="rounded bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">{model.id}/</code>
                  <Tooltip content={t('local.openModelFolder')}>
                    <button
                      type="button"
                      aria-label={t('local.openModelFolderAria', { name: modelName })}
                      onClick={() => void invoke<string>('open_model_folder', { modelId: model.id })}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </Tooltip>
                </div>
                <div className="space-y-1.5">
                  {source ? (
                    source.files.map((file) => (
                      <CopyLink key={file.name} url={file.url} label={file.name} />
                    ))
                  ) : (
                    <>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('local.archiveNote')}
                      </p>
                      <CopyLink url={archiveUrl} label={t('local.archiveLabel')} />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </>
    </Modal>
  )
}

function ModelsDirSection({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<ModelsDirInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ dir: string | null } | null>(null)

  const load = async () => {
    try { setInfo(await invoke<ModelsDirInfo>('get_models_dir')) } catch { /* ignore */ }
  }
  useEffect(() => { void load() }, [])

  async function pickDir() {
    setError('')
    try {
      const selected = await open({ directory: true, multiple: false, title: t('local.pickDirTitle') })
      if (typeof selected !== 'string') return
      if (info && selected === info.current) return
      setPending({ dir: selected })
    } catch (err) {
      setError(String(err))
    }
  }

  function requestResetDefault() {
    if (!info || !info.is_custom) return
    setPending({ dir: null })
  }

  async function applyChange() {
    if (!pending) return
    setBusy(true)
    setError('')
    try {
      await invoke<string>('set_models_dir', { dir: pending.dir, moveExisting: true })
      setPending(null)
      await load()
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-2 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t('local.storageTitle')}</h2>
          <Tooltip variant="light" content={t('local.storageHelp')}>
            <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
          </Tooltip>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 rounded-md bg-muted/30 px-3 py-2">
            <code className="min-w-0 flex-1 select-all truncate text-xs text-muted-foreground" title={info?.current}>
              {info?.current || t('common.loading')}
            </code>
            {info?.is_custom && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('local.storageCustom')}</span>
            )}
            <Tooltip content={t('local.openDir')}>
              <button
                type="button"
                aria-label={t('local.openDirAria')}
                onClick={() => void invoke<string>('open_models_folder')}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
          <Button size="sm" variant="outline" onClick={() => void pickDir()} disabled={busy}>
            {t('local.changeLocation')}
          </Button>
          {info?.is_custom && (
            <Button size="sm" variant="ghost" onClick={requestResetDefault} disabled={busy}>
              {t('local.restoreDefault')}
            </Button>
          )}
        </div>

        {error && <Feedback className="mt-3" tone="error" message={t('local.dirOpFailed')} detail={error} />}
      </CardContent>

      {pending && (
        <Modal
          title={pending.dir === null ? t('local.restoreDefaultTitle') : t('local.changeLocationTitle')}
          onClose={() => setPending(null)}
          locked={busy}
          panelClassName="w-[420px]"
        >
          <>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              {t('local.newLocation', { dir: pending.dir === null ? (info?.default_dir || t('local.defaultDir')) : pending.dir })}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('local.migrateNote')}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPending(null)} disabled={busy}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => void applyChange()} disabled={busy}>
                {busy ? (<><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />{t('common.processing')}</>) : t('common.confirm')}
              </Button>
            </div>
          </>
        </Modal>
      )}
    </Card>
  )
}

export default function LocalModeSection() {
  useT()
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [downloadedModels, setDownloadedModels] = useState<LocalModelInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadSource, setDownloadSource] = useState(
    () => getLocale() === 'en' ? 'HuggingFace' : 'HuggingFace Mirror',
  )
  const [preloadingModelId, setPreloadingModelId] = useState('')
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({})
  const [showMore, setShowMore] = useState(false)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [offlineGuideOpen, setOfflineGuideOpen] = useState(false)
  const [gpuSummary, setGpuSummary] = useState<string | null>(null)

  useEffect(() => {
    void loadData()
    const unlisten = listen<DownloadProgress>('model-download-progress', (event) => {
      const p = event.payload
      setDownloading((prev) => ({ ...prev, [p.model_id]: p }))
      if (p.status === 'completed' || p.status === 'failed') {
        void refreshDownloaded()
      }
    })
    const onDirChanged = () => { void refreshDownloaded() }
    window.addEventListener(MODELS_DIR_CHANGED_EVENT, onDirChanged)
    return () => {
      void unlisten.then((fn) => fn())
      window.removeEventListener(MODELS_DIR_CHANGED_EVENT, onDirChanged)
    }
  }, [])

  async function loadData() {
    let available: ModelInfo[] = []
    try {
      const [a, downloaded] = await Promise.all([
        invoke<ModelInfo[]>('list_available_models'),
        invoke<LocalModelInfo[]>('list_downloaded_models'),
      ])
      available = a
      setAvailableModels(a)
      setDownloadedModels(downloaded)
      setListState('ready')
      setListError('')
    } catch (err) {
      setListState('error')
      setListError(String(err))
    }

    try {
      const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
      const gpus = diag.devices.filter((d) => d.kind !== 'cpu')
      setGpuSummary(gpus.length > 0
        ? formatList(gpus
          .map((d) => `${cleanDeviceName(d.name)}${d.memory_mb > 0 ? t('local.vram', { gb: (d.memory_mb / 1024).toFixed(0) }) : ''}`))
        : '')
    } catch {
      setGpuSummary(null)
    }

    const selected = await getSetting('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf') as string
    setSelectedModelId(selected)
    const defaultSource = 'HuggingFace'
    setDownloadSource(await getSetting('localAsr.downloadSource', defaultSource) as string)

    const selectedInfo = available.find((m) => m.id === selected)
    if (selectedInfo && !selectedInfo.featured) setShowMore(true)
  }

  async function refreshDownloaded() {
    try {
      const downloaded = await invoke<LocalModelInfo[]>('list_downloaded_models')
      setDownloadedModels(downloaded)
    } catch { /* ignore */ }
  }

  async function handleDownload(modelId: string) {
    try {
      await invoke('download_model', { modelId, source: downloadSource })
      setSelectedModelId(modelId)
      await setSetting('localAsr.modelId', modelId)
      void refreshModeStatus()
      try {
        const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
        const gpuDevice = await getSetting('localAsr.gpuDevice', '') as string
        await invoke<string>('preload_local_model', { modelId, accelerator, gpuDevice })
      } catch { /* ignore */ }
      reconnectProvider()
    } catch (err) {
      setDownloading((prev) => ({
        ...prev,
        [modelId]: {
          ...prev[modelId],
          model_id: modelId,
          file_name: '',
          downloaded_bytes: 0,
          total_bytes: 0,
          percent: 0,
          status: 'failed',
          error: String(err),
        },
      }))
    }
  }

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function handleDelete(modelId: string) {
    setConfirmDeleteId(null)
    try {
      await invoke('delete_model', { modelId })
      await refreshDownloaded()
      setDownloading((prev) => {
        const next = { ...prev }
        delete next[modelId]
        return next
      })
      void refreshModeStatus()
      reconnectProvider()
    } catch { /* ignore */ }
  }

  async function retryWithOtherSource(modelId: string) {
    const options = availableModels[0]?.sources.map((s) => s.source) ?? []
    const next = options.find((s) => s !== downloadSource) ?? downloadSource
    setDownloadSource(next)
    await setSetting('localAsr.downloadSource', next)
    setDownloading((prev) => {
      const rest = { ...prev }
      delete rest[modelId]
      return rest
    })
    await handleDownload(modelId)
  }

  async function handleSelectModel(modelId: string) {
    if (preloadingModelId) return
    setSelectedModelId(modelId)
    setPreloadingModelId(modelId)
    await setSetting('localAsr.modelId', modelId)
    void refreshModeStatus()
    try {
      const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
      const gpuDevice = await getSetting('localAsr.gpuDevice', '') as string
      await invoke<string>('preload_local_model', { modelId, accelerator, gpuDevice })
    } catch {  } finally {
      setPreloadingModelId('')
      reconnectProvider()
    }
  }

  const downloadedIds = new Set(downloadedModels.filter((m) => m.complete).map((m) => m.id))

  const featuredModels = availableModels.some((m) => m.featured)
    ? availableModels.filter((m) => m.featured)
    : availableModels
  const moreModels = availableModels.filter((m) => !featuredModels.includes(m))
  const visibleModels = showMore ? [...featuredModels, ...moreModels] : featuredModels

  const sourceOptions = availableModels[0]?.sources.map((s) => s.source) ?? []
  const effectiveSource = sourceOptions.includes(downloadSource)
    ? downloadSource
    : sourceOptions[0] ?? downloadSource

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('local.modelTitle')}</h2>
            <Tooltip content={t('local.openModelDir')}>
              <button
                type="button"
                aria-label={t('local.openModelDir')}
                onClick={() => void invoke<string>('open_models_folder')}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>

          {selectedModelId && downloadedIds.has(selectedModelId) && (
            <p className="mb-2 text-sm text-muted-foreground">
              {t('local.currentModel', { name: availableModels.find((m) => m.id === selectedModelId)?.name || selectedModelId })}
            </p>
          )}
          {selectedModelId && !downloadedIds.has(selectedModelId) && listState === 'ready' && (
            <Feedback
              className="mb-3"
              tone="warning"
              message={t('local.notDownloadedWarning')}
            />
          )}

          {gpuSummary !== null && (
            <p className="mb-4 text-xs text-muted-foreground">
              {gpuSummary
                ? t('local.gpuDetected', { gpu: gpuSummary })
                : t('local.noGpu')}
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span id="download-source-label" className="text-sm text-muted-foreground">{t('local.downloadSource')}</span>
            <Segmented
              labelledBy="download-source-label"
              size="sm"
              value={effectiveSource}
              options={sourceOptions.map((src) => ({ value: src, label: sourceLabel(src) }))}
              onChange={(src) => { setDownloadSource(src); void setSetting('localAsr.downloadSource', src) }}
              className="shrink-0 justify-end"
            />
          </div>

          {listState === 'loading' && (
            <p className="py-4 text-sm text-muted-foreground">{t('local.loadingCatalog')}</p>
          )}
          {listState === 'error' && (
            <Feedback
              tone="error"
              message={t('local.catalogError')}
              detail={listError}
              actions={[{ label: t('local.reload'), onClick: () => void loadData() }]}
            />
          )}
          {listState === 'ready' && availableModels.length === 0 && (
            <Feedback
              tone="warning"
              message={t('local.catalogEmpty')}
            />
          )}

          <div className="space-y-2">
            {visibleModels.map((model) => {
              const modelName = localModelDisplayName(model)
              const modelDescription = localModelDisplayDescription(model)
              const modelLanguages = localModelDisplayLanguages(model)
              const isDownloaded = downloadedIds.has(model.id)
              const isSelected = selectedModelId === model.id
              const progress = downloading[model.id]
              const isDownloading = progress?.status === 'downloading'

              return (
                <div
                  key={model.id}
                  className={`flex items-center justify-between rounded-lg border p-3 ${isSelected ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{modelName}</span>
                      {model.recommended && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('local.recommended')}</span>
                      )}
                      {isDownloaded && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Check className="h-3 w-3" />{t('local.downloaded')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{modelDescription}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                      {model.speed ? <MiniRating label={t('local.speed')} value={model.speed} /> : null}
                      {model.accuracy ? <MiniRating label={t('local.accuracy')} value={model.accuracy} /> : null}
                      {model.total_size_bytes > 0 && (
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3" />
                          {formatSize(model.total_size_bytes)}
                        </span>
                      )}
                      {model.memory_mb ? (
                        <><span aria-hidden>·</span><span>{t('local.memoryUsage', { size: formatMemory(model.memory_mb) })}</span></>
                      ) : null}
                      {modelLanguages ? (
                        <><span aria-hidden>·</span><span>{modelLanguages}</span></>
                      ) : null}
                    </div>
                    {isDownloading && progress && (
                      <div className="mt-2">
                        <div
                          role="progressbar"
                          aria-label={t('local.downloadingAria', { name: modelName })}
                          aria-valuenow={Math.round(progress.percent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                          {progress.file_count > 1
                            ? t('local.fileProgress', { index: progress.file_index, count: progress.file_count })
                            : ''}
                          {progress.file_name} — {progress.percent.toFixed(1)}%
                          {progress.total_bytes > 0
                            ? t('local.downloadProgressBytes', {
                              downloaded: formatSize(progress.downloaded_bytes),
                              total: formatSize(progress.total_bytes),
                            })
                            : t('local.downloadedBytes', { downloaded: formatSize(progress.downloaded_bytes) })}
                        </p>
                      </div>
                    )}
                    {progress?.status === 'failed' && (() => {
                      const friendly = describeDownloadError(progress.error ?? '')
                      const hasOtherSource = sourceOptions.some((s) => s !== effectiveSource)
                      return (
                        <Feedback
                          className="mt-2"
                          tone="error"
                          message={friendly.message}
                          detail={friendly.detail}
                          actions={[
                            ...(friendly.action === 'switch_source' && hasOtherSource
                              ? [{
                                label: t('local.switchSourceRetry', { source: sourceLabel(sourceOptions.find((s) => s !== effectiveSource) ?? '') }),
                                onClick: () => void retryWithOtherSource(model.id),
                              }]
                              : [{ label: t('common.retry'), onClick: () => void handleDownload(model.id) }]),
                            { label: t('local.manualGuide'), onClick: () => setOfflineGuideOpen(true) },
                          ]}
                        />
                      )
                    })()}
                  </div>
                  <div className="ml-3 flex gap-2">
                    {isDownloaded ? (
                      <>
                        {!isSelected && (
                          <Button
                            size="sm" variant="outline"
                            disabled={preloadingModelId !== ''}
                            onClick={() => void handleSelectModel(model.id)}
                          >
                            {preloadingModelId === model.id ? t('local.loadingModel') : t('local.select')}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(model.id)}>
                          {t('common.delete')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void handleDownload(model.id)}
                        disabled={isDownloading}
                      >
                        {isDownloading ? t('local.downloading') : t('local.download')}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {preloadingModelId && (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 flex items-start gap-2 rounded-md border border-info/25 bg-info/5 px-3 py-2.5"
            >
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-info-strong" aria-hidden />
              <p className="text-sm leading-relaxed text-foreground">
                {t('local.preloading', { name: availableModels.find((m) => m.id === preloadingModelId)?.name || preloadingModelId })}
                {' '}
                {t('local.preloadingNote')}
              </p>
            </div>
          )}

          {moreModels.length > 0 && (
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore(!showMore)}
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {showMore ? t('common.collapse') : t('local.moreModels', { count: moreModels.length })}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMore ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          )}

          {availableModels.length > 0 && (
            <button
              type="button"
              onClick={() => setOfflineGuideOpen(true)}
              className="mt-3 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
            >
              {t('local.slowDownloadHint')}
            </button>
          )}
        </CardContent>
      </Card>

      {offlineGuideOpen && (
        <OfflineGuideDialog models={availableModels} onClose={() => setOfflineGuideOpen(false)} />
      )}

      {confirmDeleteId && (
        <Modal title={t('local.deleteModelTitle')} onClose={() => setConfirmDeleteId(null)} panelClassName="w-80">
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('local.deleteModelBody', { name: availableModels.find((m) => m.id === confirmDeleteId)?.name || confirmDeleteId })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>{t('common.cancel')}</Button>
              <Button size="sm" variant="destructive" onClick={() => void handleDelete(confirmDeleteId)}>{t('common.delete')}</Button>
            </div>
          </>
        </Modal>
      )}
    </>
  )
}

export function LocalModeAdvancedSection() {
  useT()
  const [asrLanguage, setAsrLanguage] = useState('auto')
  const [accelerator, setAccelerator] = useState('auto')
  const [gpuDevice, setGpuDevice] = useState('')
  const [unloadIdleMinutes, setUnloadIdleMinutes] = useState(0)
  const [devices, setDevices] = useState<GgufDevice[]>([])
  const [currentBackend, setCurrentBackend] = useState<string | null>(null)
  const [currentDevice, setCurrentDevice] = useState<string | null>(null)
  const [loadingModel, setLoadingModel] = useState<string | null>(null)
  const [diagnosticsState, setDiagnosticsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [rebinding, setRebinding] = useState(false)

  async function refreshDiagnostics() {
    try {
      const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
      setDevices(diag.devices)
      setCurrentBackend(diag.current_backend)
      setCurrentDevice(diag.current_device)
      setLoadingModel(diag.loading_model)
      setDiagnosticsState('ready')
    } catch {
      setDiagnosticsState('error')
    }
  }

  useEffect(() => {
    void (async () => {
      setAsrLanguage(await getSetting('localAsr.language', 'auto') as string)
      setAccelerator(await getSetting('localAsr.accelerator', 'auto') as string)
      setGpuDevice(await getSetting('localAsr.gpuDevice', '') as string)
      setUnloadIdleMinutes(Number(await getSetting('localAsr.unloadIdleMinutes', 0)) || 0)
      await refreshDiagnostics()
    })()
  }, [])

  const gpuDevices = devices.filter((d) => d.is_gpu)
  const hasGpu = gpuDevices.length > 0
  const gpuSummary = formatList(gpuDevices
    .map((d) => `${cleanDeviceName(d.name)}${d.memory_mb > 0 ? t('local.vram', { gb: (d.memory_mb / 1024).toFixed(0) }) : ''}`))

  const showGpuPicker = gpuDevices.length > 1 && accelerator !== 'cpu'

  async function handleSelectAccelerator(value: string) {
    if (rebinding) return
    setAccelerator(value)
    await setSetting('localAsr.accelerator', value)
    await rebindEngine({ accelerator: value, gpuDevice })
  }

  async function handleSelectGpuDevice(value: string) {
    if (rebinding) return
    setGpuDevice(value)
    await setSetting('localAsr.gpuDevice', value)
    await rebindEngine({ accelerator, gpuDevice: value })
  }

  async function rebindEngine(opts: { accelerator: string; gpuDevice: string }) {
    setRebinding(true)
    try {
      const modelId = await getSetting('localAsr.modelId', 'nemotron-asr-streaming-0.6b-gguf') as string
      await invoke<string>('preload_local_model', {
        modelId,
        accelerator: opts.accelerator,
        gpuDevice: opts.gpuDevice,
      })
    } catch { /* ignore */ } finally {
      await refreshDiagnostics()
      setRebinding(false)
    }
  }

  async function handleSelectUnloadIdle(value: number) {
    setUnloadIdleMinutes(value)
    try {
      await setSetting('localAsr.unloadIdleMinutes', value)
      await invoke('set_local_model_idle_unload', { idleMinutes: value })
    } catch {  }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id="local-language-heading" className="text-lg font-semibold">{t('local.languageTitle')}</h2>
              <p className="mt-2 text-xs text-muted-foreground">{t('local.languageNote')}</p>
            </div>
            <Segmented
              labelledBy="local-language-heading"
              value={asrLanguage}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'zh', label: t('local.lang.zh') },
                { value: 'en', label: t('local.lang.en') },
              ]}
              onChange={(value) => { setAsrLanguage(value); void setSetting('localAsr.language', value) }}
              className="shrink-0 justify-end"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <h2 id="accelerator-heading" className="text-lg font-semibold">{t('local.backendTitle')}</h2>
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs ${diagnosticsState === 'ready' && hasGpu
                ? 'border-success/30 bg-success/10 text-success-strong'
                : 'border-border bg-muted/40 text-muted-foreground'
                }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${diagnosticsState === 'ready' && hasGpu ? 'bg-success' : 'bg-muted-foreground'}`} aria-hidden />
                {diagnosticsState === 'loading' ? t('local.backendChecking') : diagnosticsState === 'error' ? t('local.backendCheckFailed') : hasGpu ? t('local.backendGpuReady') : t('local.backendCpuOnly')}
              </span>
            </div>
            <Segmented
              labelledBy="accelerator-heading"
              value={accelerator}
              disabled={rebinding}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'gpu', label: 'GPU' },
                { value: 'cpu', label: 'CPU' },
              ]}
              onChange={(value) => void handleSelectAccelerator(value)}
              className="shrink-0 justify-end"
            />
          </div>
          {diagnosticsState === 'ready' && hasGpu && (
            <p className="mt-2 text-xs text-muted-foreground">
              {gpuSummary}
              {loadingModel
                ? t('local.backendLoadingModel')
                : showGpuPicker && currentDevice
                  ? t('local.backendCurrentDevice', { device: cleanDeviceName(currentDevice) })
                  : currentBackend
                    ? t('local.backendCurrent', { backend: currentBackend.toUpperCase() })
                    : ''}
            </p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {diagnosticsState === 'loading'
              ? t('local.backendHintLoading')
              : diagnosticsState === 'error'
                ? t('local.backendHintError')
                : hasGpu
                  ? t('local.backendHintGpu')
                  : t('local.backendHintCpu')}
          </p>

          {showGpuPicker && (
            <div className="mt-4 border-t border-border pt-4">
              <label id="gpu-device-heading" className="mb-2 block text-sm text-foreground">
                {t('local.gpuDeviceTitle')}
              </label>
              <Select
                labelledBy="gpu-device-heading"
                value={gpuDevice}
                disabled={rebinding}
                onChange={(value) => void handleSelectGpuDevice(value)}
                options={[
                  { value: '', label: t('local.gpuDeviceAuto') },
                  ...gpuDevices.map((d) => ({
                    value: d.id,
                    label: `${cleanDeviceName(d.name)}${d.memory_mb > 0 ? t('local.vram', { gb: (d.memory_mb / 1024).toFixed(0) }) : ''}`,
                  })),
                ]}
                className="sm:max-w-md"
              />
              <p className="mt-2 text-xs text-muted-foreground">{t('local.gpuDeviceHint')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id="unload-idle-heading" className="text-lg font-semibold">{t('local.unloadTitle')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('local.unloadDesc')}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {unloadIdleMinutes === 0
                  ? t('local.unloadNever')
                  : t('local.unloadAfter', {
                    duration: unloadIdleMinutes === 60 ? t('local.unload.1h') : t('local.minutes', { count: unloadIdleMinutes }),
                  })}
              </p>
            </div>
            <Segmented
              labelledBy="unload-idle-heading"
              value={unloadIdleMinutes}
              options={[
                { value: 0, label: t('local.unload.never') },
                { value: 10, label: t('local.unload.10m') },
                { value: 30, label: t('local.unload.30m') },
                { value: 60, label: t('local.unload.1h') },
              ]}
              onChange={(value) => void handleSelectUnloadIdle(value)}
              className="shrink-0 justify-end"
            />
          </div>
        </CardContent>
      </Card>

      <ModelsDirSection onChanged={() => window.dispatchEvent(new Event(MODELS_DIR_CHANGED_EVENT))} />
    </>
  )
}
