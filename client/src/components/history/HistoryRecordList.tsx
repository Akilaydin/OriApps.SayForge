import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, VolumeX, Star, Play, Pause, RotateCcw, Loader2, Download, Check, Copy, X, FolderOpen, Pencil, ChevronDown, ChevronUp } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { type HistoryRecord } from '@/services/store'
import * as bridge from '@/services/bridge'
import { pickVoiceDurationSec } from '@/services/timeModel'
import { loadAudioAsDataUrl } from '@/services/audioFileService'
import { invoke } from '@tauri-apps/api/core'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'
import { historyFailureReasonDisplay } from '@/i18n/displayNames'
import { useRecordingPlayback } from './useRecordingPlayback'
import { AudioProgressBar } from './AudioProgressBar'

const ASR_PROVIDER_DISPLAY: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  doubao: 'Doubao-Seed-ASR',
  qwen: 'qwen3-asr-flash',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_flash: 'qwen3-omni-flash-realtime',
  qwen_omni_turbo: 'qwen-omni-turbo-realtime',
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
}

interface HistoryRecordListProps {
  records: HistoryRecord[]
  onDelete: (id: string) => Promise<void> | void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
  onEdit?: (id: string, nextText: string) => Promise<void> | void
  emptyText?: string
  highlight?: string
}

function getDayLabel(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const recordDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const dateStr = date.toLocaleDateString(getLocale(), { month: 'long', day: 'numeric' })
  if (recordDay.getTime() === today.getTime()) return t('record.dayPrefix', { day: t('record.today'), date: dateStr })
  if (recordDay.getTime() === yesterday.getTime()) return t('record.dayPrefix', { day: t('record.yesterday'), date: dateStr })
  return date.toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
}

function highlightText(text: string, keyword: string) {
  const kw = keyword.trim()
  if (!kw) return text
  const lower = text.toLowerCase()
  const kwLower = kw.toLowerCase()
  const parts: Array<string | JSX.Element> = []
  let from = 0
  let idx = lower.indexOf(kwLower, from)
  let key = 0
  while (idx !== -1) {
    if (idx > from) parts.push(text.slice(from, idx))
    parts.push(
      <mark key={key++} className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30">
        {text.slice(idx, idx + kw.length)}
      </mark>,
    )
    from = idx + kw.length
    idx = lower.indexOf(kwLower, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function HistoryItem({
  record,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  highlight = '',
}: {
  record: HistoryRecord
  onDelete: () => void
  onToggleFavorite?: (nextFavorite: boolean) => void
  onReprocess?: () => Promise<void> | void
  onEdit?: (nextText: string) => Promise<void> | void
  highlight?: string
}) {
  //
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [reprocessing, setReprocessing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [downloadPath, setDownloadPath] = useState('')
  const [copied, setCopied] = useState(false)
  const playback = useRecordingPlayback(record.audioFilePath)

  const text = record.llmText || record.asrText
  const isEmpty = record.isEmpty || (!text && record.charCount === 0)
  const voiceDurationSec = pickVoiceDurationSec({
    holdSec: record.durationSec,
    audioSec: record.audioDurationSec,
    asrSec: record.asrDurationSec,
  })

  const handleReprocess = useCallback(async () => {
    if (!onReprocess || reprocessing) return
    setReprocessing(true)
    try {
      await onReprocess()
    } finally {
      setReprocessing(false)
    }
  }, [onReprocess, reprocessing])

  const editTextRef = useRef('')
  const editingRef = useRef(false)
  const textRef = useRef(text)
  const onEditRef = useRef(onEdit)
  textRef.current = text
  onEditRef.current = onEdit

  const startEdit = useCallback(() => {
    editTextRef.current = text
    editingRef.current = true
    setEditText(text)
    setEditing(true)
  }, [text])

  const commitEdit = useCallback(async () => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    const next = editTextRef.current
    if (!onEditRef.current || next === textRef.current) return
    await onEditRef.current(next)
  }, [])

  const cancelEdit = useCallback(() => {
    editingRef.current = false
    setEditing(false)
  }, [])

  useEffect(() => () => { void commitEdit() }, [commitEdit])

  const handleDownloadAudio = useCallback(async () => {
    if (!record.audioFilePath || downloading) return
    setDownloading(true)
    setDownloadStatus('idle')
    setDownloadPath('')
    try {
      const dataUrl = await loadAudioAsDataUrl(record.audioFilePath)
      if (!dataUrl) {
        setDownloadStatus('fail')
        setDownloadPath(t('record.audioMissing'))
        setTimeout(() => setDownloadStatus('idle'), 3000)
        return
      }

      const ts = new Date(record.timestamp)
      const dateStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
      const filename = `sayit_${dateStr}.wav`

      // Extract base64 from data URL
      const base64Data = dataUrl.split(',')[1]
      const savedPath = await invoke<string>('save_audio_to_downloads', {
        base64Data,
        filename,
      })

      setDownloadStatus('ok')
      setDownloadPath(savedPath)
      setTimeout(() => setDownloadStatus('idle'), 5000)
    } catch (err) {
      setDownloadStatus('fail')
      setDownloadPath(String(err))
      setTimeout(() => setDownloadStatus('idle'), 3000)
    } finally {
      setDownloading(false)
    }
  }, [record.audioFilePath, record.timestamp, downloading])

  const open = expanded

  return (
    <div
      className="group rounded-md transition-colors hover:bg-accent/50"
      style={{ overflowAnchor: 'none' }}
    >
      <div className="flex items-start gap-2 px-2 py-2">
        <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground">
          {formatTime(record.timestamp)}
        </span>

        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-2">
          <div className="min-w-0">
            {editing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <textarea
                  value={editText}
                  onChange={(e) => { setEditText(e.target.value); editTextRef.current = e.target.value }}
                  autoFocus
                  rows={Math.min(Math.max(editText.split('\n').length, 2), 12)}
                  className="w-full resize-y rounded-md border border-input-border bg-input-bg px-2.5 py-1.5 text-sm leading-relaxed focus:border-input-focus-border focus:outline-none"
                  onBlur={() => { void commitEdit() }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
                  }}
                />
                <span className="mt-1 inline-block text-[11px] text-muted-foreground/50">{t('record.editHint')}</span>
              </div>
            ) : isEmpty ? (
              <div className="flex items-center gap-2">
                <VolumeX className="h-3.5 w-3.5 text-muted-foreground/40" />
                <p className="text-sm italic text-muted-foreground/60">{t('record.noSpeech')}</p>
              </div>
            ) : (
              <div
                className="cursor-pointer text-sm leading-relaxed text-foreground/75 select-text transition-colors hover:text-foreground"
                onClick={() => {
                  const selection = window.getSelection()
                  if (selection && selection.toString().trim()) return
                  void bridge.copyText(text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
              >
                {(() => {
                  const editedMark = record.manualEditedAt ? (
                    <Tooltip content={t('record.edited')}>
                      <Pencil className="ml-1 inline-block h-3 w-3 translate-y-[1px] text-muted-foreground/40" />
                    </Tooltip>
                  ) : null
                  if (text.includes('\n')) {
                    const paras = text.split(/\n{2,}/)
                    return paras.map((para, idx) => (
                      <p key={idx} className={idx > 0 ? 'mt-1.5' : undefined}>
                        {highlightText(para, highlight)}
                        {idx === paras.length - 1 && editedMark}
                      </p>
                    ))
                  }
                  return <p>{highlightText(text, highlight)}{editedMark}</p>
                })()}
              </div>
            )}
          </div>

          <div className={`flex h-fit shrink-0 self-start gap-0.5 transition-opacity group-hover:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}>
            {!isEmpty && (
              <Tooltip content={copied ? t('record.copied') : t('record.copyText')} forceVisible={copied}>
                <button
                  onClick={() => {
                    void bridge.copyText(text).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                  className="inline-flex items-center rounded p-1 transition-colors hover:bg-accent"
                  aria-label={t('record.copy')}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              </Tooltip>
            )}

            {onToggleFavorite && (
              <Tooltip content={record.favorite ? t('record.unfavorite') : t('record.favorite')}>
                <button
                  onClick={() => onToggleFavorite(!record.favorite)}
                  className="rounded p-1 hover:bg-accent"
                  aria-label={record.favorite ? t('record.unfavorite') : t('record.favorite')}
                >
                  <Star className={`h-3.5 w-3.5 ${record.favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
                </button>
              </Tooltip>
            )}

            <Tooltip content={expanded ? t('record.collapse') : t('record.expand')}>
              <button
                onClick={() => setExpanded(!expanded)}
                className="rounded p-1 hover:bg-accent"
                aria-label={t('record.details')}
                aria-expanded={expanded}
              >
                {expanded
                  ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            </Tooltip>

            <Tooltip content={t('record.deleteRecord')}>
              <button
                onClick={onDelete}
                className="rounded p-1 hover:bg-accent"
                aria-label={t('record.delete')}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </button>
            </Tooltip>
          </div>

          <div
            className="col-span-2 grid grid-cols-subgrid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
            style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
            aria-hidden={!open}
          >
            <div className="col-span-2 grid grid-cols-subgrid overflow-hidden">
              <div className="col-span-2 mt-2 grid grid-cols-subgrid gap-y-2 text-xs">
                {isEmpty && (record.failReasonCode || record.failReason) && (
                  <div className="col-span-2 text-muted-foreground">
                    <span className="font-medium">{t('record.reasonLabel')}</span>
                    <span className="whitespace-pre-line break-words">{historyFailureReasonDisplay(record)}</span>
                  </div>
                )}
                {!isEmpty && record.asrText && (
                  <div className="text-muted-foreground">
                    <span className="font-medium">{t('record.asrLabel')}</span>
                    <span className="whitespace-pre-line">{highlightText(record.asrText, highlight)}</span>
                  </div>
                )}
                <div className="col-span-2 flex flex-wrap items-center gap-2 text-muted-foreground">
                  {record.workMode && (
                    <>
                      <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                        {record.workMode === 'server' ? t('record.modeServer') : record.workMode === 'cloud_api' ? t('record.modeCloudApi') : t('record.modeLocal')}
                      </span>
                      {record.asrProvider && (
                        <span className="text-xs">ASR: {ASR_PROVIDER_DISPLAY[record.asrProvider] || record.asrProvider}</span>
                      )}
                      {record.aiProvider && record.aiProvider !== 'server' && record.llmMs > 0 && (
                        <span className="text-xs">
                          AI: {record.aiProvider}{record.aiModel ? ` (${record.aiModel})` : ''}
                        </span>
                      )}
                      <span className="text-border">|</span>
                    </>
                  )}
                  <span>{t('record.voiceLength', { sec: voiceDurationSec.toFixed(1) })}</span>
                  <span className="text-border">|</span>
                  <span>{t('record.recognizeTime', { total: ((record.asrMs + record.llmMs) / 1000).toFixed(1), asr: record.asrMs, llm: record.llmMs })}</span>

                  <div className="flex items-center gap-0.5">
                    {!isEmpty && onEdit && !editing && (
                      <Tooltip content={t('record.editText')}>
                        <button
                          type="button"
                          onClick={startEdit}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent"
                          aria-label={t('record.edit')}
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && (
                      <Tooltip content={playback.playing ? t('record.pause') : t('record.play')}>
                        <button
                          type="button"
                          onClick={() => { void playback.toggle() }}
                          disabled={playback.loading}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={playback.playing ? t('record.pause') : t('record.play')}
                        >
                          {playback.loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : playback.playing ? (
                            <Pause className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <Play className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && (
                      <Tooltip content={downloadStatus === 'ok' ? t('record.savedTo', { path: downloadPath }) : downloadStatus === 'fail' ? t('record.downloadFailed', { path: downloadPath }) : t('record.downloadAudio')}>
                        <button
                          type="button"
                          onClick={() => { void handleDownloadAudio() }}
                          disabled={downloading}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={t('record.downloadAudio')}
                        >
                          {downloading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : downloadStatus === 'ok' ? (
                            <Check className="h-3.5 w-3.5 text-success" />
                          ) : downloadStatus === 'fail' ? (
                            <X className="h-3.5 w-3.5 text-destructive" />
                          ) : (
                            <Download className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && onReprocess && (
                      <Tooltip content={t('record.reprocess')}>
                        <button
                          type="button"
                          onClick={() => { void handleReprocess() }}
                          disabled={reprocessing}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={t('record.reprocess')}
                        >
                          {reprocessing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>
                {downloadStatus === 'ok' && downloadPath && (
                  <div className="col-span-2 mt-1 flex items-center gap-2 text-xs text-success break-all">
                    <span className="min-w-0 truncate">{t('record.savedTo', { path: downloadPath })}</span>
                    <button
                      onClick={() => void invoke('reveal_file_in_folder', { filePath: downloadPath })}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={t('record.openFolder')}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {downloadStatus === 'fail' && downloadPath && (
                  <div className="col-span-2 mt-1 text-xs text-destructive break-all">
                    {t('record.downloadFailed', { path: downloadPath })}
                  </div>
                )}
                {playback.ready && <AudioProgressBar playback={playback} className="col-span-2 mt-2" />}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}

function DayGroup({
  label,
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  highlight,
}: {
  label: string
  records: HistoryRecord[]
  onDelete: (id: string) => void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
  onEdit?: (id: string, nextText: string) => Promise<void> | void
  highlight?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h2>
        <div className="divide-y">
          {records.map((record) => (
            <HistoryItem
              key={record.id}
              record={record}
              onDelete={() => onDelete(record.id)}
              onToggleFavorite={onToggleFavorite ? (next) => onToggleFavorite(record.id, next) : undefined}
              onReprocess={onReprocess ? () => onReprocess(record) : undefined}
              onEdit={onEdit ? (nextText) => onEdit(record.id, nextText) : undefined}
              highlight={highlight}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default function HistoryRecordList({
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  emptyText,
  highlight,
}: HistoryRecordListProps) {
  useT()
  const resolvedEmptyText = emptyText ?? t('history.empty')
  const grouped = useMemo(() => {
    return records.reduce((acc, record) => {
      const label = getDayLabel(record.timestamp)
      if (!acc[label]) acc[label] = []
      acc[label].push(record)
      return acc
    }, {} as Record<string, HistoryRecord[]>)
  }, [records])

  const sortedDays = useMemo(() => {
    return Object.keys(grouped).sort((a, b) => {
      const todayLabel = t('record.today')
      const yesterdayLabel = t('record.yesterday')
      const aIsToday = a.startsWith(todayLabel)
      const bIsToday = b.startsWith(todayLabel)
      const aIsYesterday = a.startsWith(yesterdayLabel)
      const bIsYesterday = b.startsWith(yesterdayLabel)
      if (aIsToday) return -1
      if (bIsToday) return 1
      if (aIsYesterday) return -1
      if (bIsYesterday) return 1
      return b.localeCompare(a)
    })
  }, [grouped])

  if (records.length === 0) {
    return <p className="py-12 text-center text-muted-foreground">{resolvedEmptyText}</p>
  }

  return (
    <div className="space-y-3">
      {sortedDays.map((day) => (
        <DayGroup
          key={day}
          label={day}
          records={grouped[day]}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
          onReprocess={onReprocess}
          onEdit={onEdit}
          highlight={highlight}
        />
      ))}
    </div>
  )
}
