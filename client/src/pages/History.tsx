import * as bridge from '@/services/bridge'
import { cn } from '@/lib/utils'
import { buildAsrExtra, resolveAsrDisplayModel } from '@/lib/asrModels'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { getWorkMode } from '@/services/transcription'
import { polishWithClientAi } from '@/services/transcription/clientAiPolish'
import {
  policyFromSnapshot,
  resolveAndLogAiOutcome,
  type AiConfigSnapshot,
  type AiOutcomeContext,
} from '@/services/transcription/aiPolicy'
import type { AiExecutionSource, AiExecutionStatus, WorkMode } from '@/services/transcription'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, Search, Check, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import HistoryRecordList from '@/components/history/HistoryRecordList'
import { exportHistory } from '@/services/exports'
import {
  countHistory,
  deleteHistory,
  listHistory,
  setHistoryFavorite,
  updateHistoryRecord,
  getSetting,
  type HistoryRecord,
} from '@/services/store'
import { loadAudioAsDataUrl } from '@/services/audioFileService'
import { useT } from '@/i18n/useT'
import { applyTextTransforms, restoreHotwordSpacing } from '@/services/textPostProcess'
import { getAiPrompt, buildHotwordInjectionPart } from '@/services/aiPrompt'
import {
  BUILTIN_SET_WORDS_KEY,
  BUILTIN_SET_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  composeHotwords,
  normalizeBuiltinSetActive,
  normalizeBuiltinSetWords,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
} from '@/services/hotwords/model'

const HISTORY_PAGE_SIZE = 100

interface ReprocessResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
  aiReason?: string
  aiProvider?: string
  aiModel?: string
}

interface ReprocessAiContext {
  snapshot: AiConfigSnapshot
  context: AiOutcomeContext
}

async function buildReprocessAiContext(recordId: string): Promise<ReprocessAiContext> {
  const [rawMin, rawEnabled] = await Promise.all([
    getSetting('aiMinDurationSec', 0),
    getSetting('aiEnabled', false),
  ])
  return {
    snapshot: {
      workMode: getWorkMode(),
      aiEnabled: Boolean(rawEnabled),
      aiMinDurationSec: Math.max(0, Number(rawMin) || 0),
    },
    context: {
      operationId: `reprocess-${recordId}-${Date.now().toString(36)}`,
      trigger: 'history_reprocess',
    },
  }
}

async function reprocessViaCloudApi(
  chunk: ArrayBuffer,
  hotwords: string[],
  ai: ReprocessAiContext,
  systemPrompt: string | undefined,
): Promise<ReprocessResult> {
  const durationSec = (chunk.byteLength / 2) / 16000
  const audioB64 = uint8ArrayToBase64(new Uint8Array(chunk))

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
  const asrConfig: Record<string, unknown> = {
    provider: asrProvider,
    api_key: asrApiKey,
    app_id: asrAppId,
    ...(extra && { extra }),
  }

  const asrStart = performance.now()
  const asrResult = await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
    request: { audio_b64: audioB64, sample_rate: 16000, asr_config: asrConfig, hotwords },
  })
  const asrText = restoreHotwordSpacing(asrResult.text, hotwords)
  const asrMs = asrResult.elapsed_ms || Math.round(performance.now() - asrStart)

  const policy = policyFromSnapshot(ai.snapshot, 'cloud_api', durationSec)
  const polish = await polishWithClientAi({
    asrText,
    startOptions: {
      runId: 1,
      operationId: ai.context.operationId,
      aiConfig: ai.snapshot,
      systemPrompt,
      source: 'history_reprocess',
    },
    policy,
    outcomeContext: ai.context,
    logSource: 'history',
  })

  return {
    asrText,
    llmText: polish?.llmText ?? asrText,
    asrMs,
    llmMs: polish?.llmMs ?? 0,
    durationSec,
    aiSource: polish?.aiSource,
    aiStatus: polish?.aiStatus,
    aiReason: polish?.aiReason,
    aiProvider: polish?.aiProvider,
    aiModel: polish?.aiModel,
  }
}

async function buildReprocessMetadata(
  workMode: WorkMode,
  result: ReprocessResult,
): Promise<{
  asrProvider?: string
  aiProvider?: string
  aiModel?: string
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
}> {
  //
  const aiFields = {
    aiSource: result.aiSource,
    aiStatus: result.aiStatus,
    aiProvider: result.aiStatus === 'skipped' ? undefined : result.aiProvider,
    aiModel: result.aiStatus === 'skipped' ? undefined : result.aiModel,
  }

  if (workMode === 'cloud_api') {
    const asrProviderKey = await getSetting('cloudAsr.provider', '') as string
    const asrSelectedModel = await getSetting('cloudAsr.model', '') as string
    return { asrProvider: resolveAsrDisplayModel(asrProviderKey, asrSelectedModel), ...aiFields }
  }
  return { ...aiFields }
}

export default function History() {
  const t = useT()
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE)
  const [totalCount, setTotalCount] = useState(0)
  const [exportResult, setExportResult] = useState<{ filePath: string | null; canceled: boolean } | null>(null)

  const loadRecords = useCallback(async (searchKeyword: string, limit: number, favOnly: boolean) => {
    const [items, total] = await Promise.all([
      listHistory({ keyword: searchKeyword, favoriteOnly: favOnly, limit, offset: 0 }),
      countHistory({ keyword: searchKeyword, favoriteOnly: favOnly }),
    ])
    setRecords(items)
    setTotalCount(total)
  }, [])

  useEffect(() => {
    setVisibleCount(HISTORY_PAGE_SIZE)
  }, [debouncedKeyword, favoriteOnly])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 300)
    return () => clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }, [debouncedKeyword, favoriteOnly, loadRecords, visibleCount])

  useEffect(() => {
    const unlisten = bridge.listen('history-updated', () => {
      void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [debouncedKeyword, visibleCount, favoriteOnly, loadRecords])

  const handleDelete = async (id: string) => {
    // Clean up audio file if it exists
    const record = records.find((r) => r.id === id)
    if (record?.audioFilePath) {
      try { await bridge.deleteAudioFile(record.audioFilePath) } catch { /* ignore */ }
    }
    await deleteHistory(id)
    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }

  const handleToggleFavorite = async (id: string, nextFavorite: boolean) => {
    await setHistoryFavorite(id, nextFavorite)
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, favorite: nextFavorite } : r)))
  }

  const handleEdit = async (id: string, nextText: string) => {
    const editedAt = Date.now()
    const patch = {
      llmText: nextText,
      charCount: nextText.length,
      isEmpty: !nextText.trim(),
      manualEditedAt: editedAt,
    }
    await updateHistoryRecord(id, patch)
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const handleExport = async () => {
    const result = await exportHistory({ keyword: debouncedKeyword })
    setExportResult(result)
    if (!result.canceled) setTimeout(() => setExportResult(null), 8000)
  }

  const handleReprocess = async (record: HistoryRecord) => {
    if (!record.audioFilePath) return

    const base64 = await bridge.readAudioFile(record.audioFilePath)
    if (!base64) return

    // Decode base64 WAV → PCM
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    const pcmData = bytes.slice(44)
    const chunk = pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength)

    // Diagnostic: compute peak amplitude of the PCM data being sent
    const pcmInt16 = new Int16Array(chunk)
    let reprocessPeak = 0
    for (let i = 0; i < pcmInt16.length; i++) {
      const v = Math.abs(pcmInt16[i])
      if (v > reprocessPeak) reprocessPeak = v
    }
    const reprocessPeakNorm = reprocessPeak / 32768
    const reprocessDurSec = pcmInt16.length / 16000
    console.log('[reprocess-diag] PCM stats', {
      byteLength: chunk.byteLength,
      samples: pcmInt16.length,
      durationSec: reprocessDurSec.toFixed(2),
      peakInt16: reprocessPeak,
      peakNormalized: reprocessPeakNorm.toFixed(4),
      wouldBeSilent: reprocessPeakNorm < 0.01,
    })

    const prompt = await getAiPrompt()
    const aiEnabled = await getSetting('aiEnabled', false)

    let hotwords: string[] = []
    try {
      const [rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive] = await Promise.all([
        getSetting(BUILTIN_SET_WORDS_KEY, {}),
        getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting(CUSTOM_THEMES_KEY, []),
        getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
      ])
      const setWords = normalizeBuiltinSetWords(rawSetWords as Record<string, unknown>)
      const setActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
      const themes = normalizeCustomThemes(rawCustomThemes)
      const themeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, themes)
      hotwords = composeHotwords([], setWords, setActive, themes, themeActive)
    } catch { /* ignore */ }


    const workMode = getWorkMode()
    let systemPrompt = aiEnabled ? prompt : undefined
    if (systemPrompt && (await getSetting('injectHotwordsToPrompt', false))) {
      const part = buildHotwordInjectionPart(hotwords)
      if (part) systemPrompt = `${systemPrompt}\n\n${part}`
    }

    const ai = await buildReprocessAiContext(record.id)

    let result: ReprocessResult
    if (workMode === 'cloud_api') {
      result = await reprocessViaCloudApi(chunk, hotwords, ai, systemPrompt)
    } else {
      throw new Error('Unsupported transcription mode')
    }

    const rawAsr = result.aiStatus
      ? result.aiStatus !== 'applied'
      : !result.llmText || result.llmText === result.asrText
    const baseText = rawAsr ? result.asrText : result.llmText
    const replacedLlm = await applyTextTransforms(baseText, { rawAsr })

    const meta = await buildReprocessMetadata(workMode, result)

    await updateHistoryRecord(record.id, {
      asrText: result.asrText,
      llmText: replacedLlm,
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      charCount: (result.llmText || result.asrText).length,
      isEmpty: !(result.llmText || result.asrText).trim(),
      workMode,
      aiSource: meta.aiSource,
      aiStatus: meta.aiStatus,
      aiProvider: meta.aiProvider,
      aiModel: meta.aiModel,
      asrProvider: meta.asrProvider,
    })

    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">{t('history.title')}</h1>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setFavoriteOnly(false)}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                !favoriteOnly ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('history.filterAll')}</button>
            <button
              type="button"
              onClick={() => setFavoriteOnly(true)}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                favoriteOnly ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('history.filterFavorites')}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              className="w-64 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
            />
          </div>
          <Tooltip content={t('history.export')}>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              onClick={() => void handleExport()}
              aria-label={t('history.export')}
              title={t('history.export')}
            >
              <Download className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {exportResult && !exportResult.canceled && exportResult.filePath && (
        <div className="mb-3 flex items-center gap-2 text-xs text-success">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t('history.savedTo', { path: exportResult.filePath })}</span>
          <button
            onClick={() => void invoke('reveal_file_in_folder', { filePath: exportResult.filePath })}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {exportResult?.canceled && (
        <p className="mb-3 text-xs text-muted-foreground">{t('history.exportCanceled')}</p>
      )}

      <HistoryRecordList
        records={records}
        onDelete={handleDelete}
        onToggleFavorite={handleToggleFavorite}
        onReprocess={handleReprocess}
        onEdit={handleEdit}
        highlight={debouncedKeyword}
        emptyText={keyword.trim() ? t('history.emptyNoMatch') : favoriteOnly ? t('history.emptyFavorites') : t('history.empty')}
      />

      {totalCount > records.length && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + HISTORY_PAGE_SIZE)}>
            {t('history.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
