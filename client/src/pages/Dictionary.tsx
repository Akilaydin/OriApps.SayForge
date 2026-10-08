import { Fragment, useEffect, useState } from 'react'
import { Plus, X, Search, RotateCcw, ChevronDown, ChevronUp, FolderPlus, Trash2, Download, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrModelsOf,
  type AsrPlatform,
} from '@/features/settings/asrProviderCatalog'
import {
  expectedClientCap,
  expectedHotwordDelivery,
  foldHotwordDelivery,
  hotwordDependsOnStreamingPath,
  hotwordUndecidedReason,
  type HotwordUiState,
  type HotwordUndecidedReason,
} from '@/lib/asrModels'
import { cn } from '@/lib/utils'
import * as bridge from '@/services/bridge'
import { exportHotwords } from '@/services/exports'
import { getSetting } from '@/services/store'
import { BUILTIN_SETS, MAX_HOTWORDS } from '@/services/hotwords/model'
import { useHotwordsManager } from '@/services/hotwords/useHotwordsManager'
import TextReplacementSection from '@/components/TextReplacementSection'
import TextFormatSection from '@/components/TextFormatSection'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { t, type TranslationKey } from '@/i18n'
import { RichText } from '@/i18n/RichText'
import { useT } from '@/i18n/useT'

type Tab = 'hotwords' | 'replacement'

const HOTWORD_SOFT_LIMIT = 200
const CHIPS_COLLAPSE_LIMIT = 30

function WordChips({
  words,
  onRemove,
  expandAll = false,
}: {
  words: string[]
  onRemove: (word: string) => void
  expandAll?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const overflow = words.length > CHIPS_COLLAPSE_LIMIT
  const shown = expanded || expandAll || !overflow ? words : words.slice(0, CHIPS_COLLAPSE_LIMIT)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((word) => (
          <span
            key={word}
            className="inline-flex items-center gap-1 rounded-md border bg-secondary/50 px-2 py-0.5 text-xs"
          >
            {word}
            <button
              onClick={() => onRemove(word)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('dict.deleteWord', { word })}
            >
              <X className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
          </span>
        ))}
      </div>
      {overflow && !expandAll && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t('dict.collapse') : t('dict.expandAll', { count: words.length })}
        </button>
      )}
    </div>
  )
}

function deliveryMessageKey(
  ui: HotwordUiState,
  reason: HotwordUndecidedReason | null,
): TranslationKey {
  if (ui === 'sent') return 'dict.delivery.sent'
  if (ui === 'not_sent') return 'dict.delivery.notSent'
  switch (reason) {
    case 'declaration_missing': return 'dict.delivery.undecidedDeclaration'
    case 'query_failed': return 'dict.delivery.undecidedQueryFailed'
    default: return 'dict.delivery.undecided'
  }
}

function HotwordDeliveryNotice({ hotwordCount }: { hotwordCount: number }) {
  const [tableOpen, setTableOpen] = useState(false)
  const [state, setState] = useState<{
    ui: HotwordUiState
    pathDependent: boolean
    clientCap: number | null
    hasSpacingRestore: boolean
    undecidedReason: HotwordUndecidedReason | null
  } | null>(null)

  useEffect(() => {
    let disposed = false

    const load = async () => {
      const mode = await getSetting('workMode', 'server') as string

      if (mode === 'local') {
        if (!disposed) {
          setState({
            ui: 'not_sent',
            pathDependent: false,
            clientCap: null,
            hasSpacingRestore: false,
            undecidedReason: null,
          })
        }
        return
      }
      if (mode === 'server') {
        if (!disposed) {
          setState({
            ui: 'sent',
            pathDependent: false,
            clientCap: null,
            hasSpacingRestore: false,
            undecidedReason: null,
          })
        }
        return
      }

      const [provider, protocol, workspaceId, streamingOn] = await Promise.all([
        getSetting('cloudAsr.provider', '') as Promise<string>,
        getSetting('cloudAsr.protocol', 'auto') as Promise<string>,
        getSetting('cloudAsr.qwen.workspaceId', '') as Promise<string>,
        getSetting('streamingDisplayEnabled', false) as Promise<boolean>,
      ])
      const [baseUrl, model] = await Promise.all([
        getSetting('cloudAsr.baseUrl', '') as Promise<string>,
        getSetting('cloudAsr.model', '') as Promise<string>,
      ])
      const capability = await bridge.asrHotwordCapability(provider, {
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(protocol && protocol !== 'auto' ? { protocol } : {}),
      })
      if (disposed) return
      if (!capability) {
        setState({
          ui: 'undecided',
          pathDependent: false,
          clientCap: null,
          hasSpacingRestore: true,
          undecidedReason: 'query_failed',
        })
        return
      }
      const pathOpts = {
        streamingDisplayEnabled: Boolean(streamingOn),
        provider,
        qwenWorkspaceId: workspaceId,
      }
      const delivery = expectedHotwordDelivery(capability, pathOpts)
      setState({
        ui: foldHotwordDelivery(delivery),
        pathDependent: hotwordDependsOnStreamingPath(capability),
        clientCap: expectedClientCap(capability, pathOpts),
        hasSpacingRestore: true,
        undecidedReason: hotwordUndecidedReason(delivery),
      })
    }

    void load()
    const onCapabilityMaybeChanged = () => { void load() }
    window.addEventListener(bridge.ASR_CAPABILITY_MAYBE_CHANGED_EVENT, onCapabilityMaybeChanged)
    return () => {
      disposed = true
      window.removeEventListener(bridge.ASR_CAPABILITY_MAYBE_CHANGED_EVENT, onCapabilityMaybeChanged)
    }
  }, [])

  if (!state) return null

  const tone = state.ui === 'sent'
    ? 'text-muted-foreground'
    : state.ui === 'undecided'
      ? 'text-muted-foreground'
      : 'text-amber-500'

  return (
    <div className={cn('mb-4 -mt-1 space-y-1 text-xs leading-relaxed', tone)}>
      <p>
        <RichText text={t(deliveryMessageKey(state.ui, state.undecidedReason))} />
        <button
          type="button"
          onClick={() => setTableOpen(true)}
          className="ml-1.5 text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
        >
          {t('dict.delivery.openTable')}
        </button>
      </p>
      {state.pathDependent && (
        <p><RichText text={t('dict.delivery.pathDependent')} /></p>
      )}
      {state.clientCap !== null && hotwordCount > state.clientCap && (
        <p className="text-amber-500">
          <RichText text={t('dict.delivery.clientCap', { cap: state.clientCap, count: hotwordCount })} />
        </p>
      )}
      {state.ui === 'not_sent' && (
        <p><RichText text={t('dict.delivery.fallbackHint')} /></p>
      )}
      {state.hasSpacingRestore && state.ui !== 'sent' && (
        <p className="text-muted-foreground"><RichText text={t('dict.delivery.spacingRestore')} /></p>
      )}
      {tableOpen && <HotwordSupportTable onClose={() => setTableOpen(false)} />}
    </div>
  )
}

interface SupportRow {
  platform: AsrPlatform
  model: string
  provider: string
  hasStreamingPath: boolean
  streaming: HotwordUiState
  buffered: HotwordUiState
  streamingCap: number | null
  bufferedCap: number | null
}

function HotwordSupportTable({ onClose }: { onClose: () => void }) {
  useT()
  const [rows, setRows] = useState<SupportRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [currentProvider, setCurrentProvider] = useState('')

  useEffect(() => {
    let disposed = false
    void (async () => {
      const [matrix, provider, mode] = await Promise.all([
        bridge.asrHotwordCapabilityMatrix(),
        getSetting('cloudAsr.provider', '') as Promise<string>,
        getSetting('workMode', 'server') as Promise<string>,
      ])
      if (disposed) return
      if (!matrix) {
        setFailed(true)
        return
      }
      setCurrentProvider(mode === 'cloud_api' ? provider : '')
      setRows(ASR_PROVIDERS.flatMap((entry) => asrModelsOf(entry).map((model) => {
        const capability = matrix[model.provider]
        const streaming = capability ? foldHotwordDelivery(capability.streaming) : 'undecided'
        const buffered = capability ? foldHotwordDelivery(capability.buffered) : 'undecided'
        return {
          platform: entry.platform,
          model: model.id,
          provider: model.provider,
          hasStreamingPath: capability?.hasStreamingPath ?? false,
          streaming,
          buffered,
          streamingCap: capability?.streamingClientCap ?? null,
          bufferedCap: capability?.bufferedClientCap ?? null,
        }
      })))
    })()
    return () => { disposed = true }
  }, [])

  const label = (state: HotwordUiState) => t(
    state === 'sent' ? 'dict.table.sent'
      : state === 'not_sent' ? 'dict.table.notSent'
        : 'dict.table.undecided',
  )
  const stateClass = (state: HotwordUiState) => state === 'sent'
    ? 'text-foreground'
    : state === 'not_sent' ? 'text-amber-500' : 'text-muted-foreground'

  const renderState = (row: SupportRow) => {
    if (!row.hasStreamingPath || row.streaming === row.buffered) {
      return <span className={stateClass(row.buffered)}>{label(row.buffered)}</span>
    }
    return (
      <span className="flex flex-col gap-0.5">
        <span className={stateClass(row.streaming)}>
          {t('dict.table.whenStreaming', { state: label(row.streaming) })}
        </span>
        <span className={stateClass(row.buffered)}>
          {t('dict.table.whenBuffered', { state: label(row.buffered) })}
        </span>
      </span>
    )
  }

  const renderNote = (row: SupportRow) => {
    const caps = new Set<number>()
    if (row.streaming === 'sent' && row.streamingCap !== null) caps.add(row.streamingCap)
    if (row.buffered === 'sent' && row.bufferedCap !== null) caps.add(row.bufferedCap)
    if (caps.size === 0) return null
    return t('dict.table.capNote', { cap: Array.from(caps).join(' / ') })
  }

  let lastPlatform: AsrPlatform | '' = ''

  return (
    <Modal
      title={t('dict.table.title')}
      onClose={onClose}
      showCloseButton
      panelClassName="w-[780px]"
    >
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <RichText text={t('dict.table.intro')} />
      </p>

      {failed && (
        <p className="mt-4 text-xs text-amber-500">{t('dict.table.unavailable')}</p>
      )}

      {rows && (
        <table className="mt-3 w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted-foreground/70">
              <th className="pb-1.5 pr-3 font-normal">{t('dict.tableModel')}</th>
              <th className="pb-1.5 pr-3 font-normal">{t('dict.tableHotword')}</th>
              <th className="pb-1.5 font-normal">{t('dict.tableNote')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isCurrent = row.provider === currentProvider
              const platformChanged = row.platform !== lastPlatform
              lastPlatform = row.platform
              return (
                <Fragment key={`${row.provider}-${row.model}`}>
                  {platformChanged && (
                    <tr>
                      <td colSpan={3} className="pb-0.5 pt-2.5 text-[11px] font-medium text-muted-foreground">
                        {ASR_PLATFORMS[row.platform].label}
                      </td>
                    </tr>
                  )}
                  <tr className={cn('align-top', isCurrent && 'bg-accent/50')}>
                    <td className="py-1 pr-3">
                      {row.model}
                      {isCurrent && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          {t('dict.table.current')}
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3">{renderState(row)}</td>
                    <td className="py-1 text-muted-foreground">{renderNote(row)}</td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        <RichText text={t('dict.table.otherModes')} />
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <RichText text={t('dict.table.footer')} />
      </p>
    </Modal>
  )
}

export default function Dictionary() {
  useT()
  const [tab, setTab] = useState<Tab>('hotwords')
  const [exportMessage, setExportMessage] = useState('')
  const [warnDismissed, setWarnDismissed] = useState(false)
  const {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
    filtered,
    filteredUnknown,
    visibleCustomThemes,
    getSetWordsInHotwords,
    getThemeWordsInHotwords,
    setNewThemeName,
    setSearch,
    setShowUnknown,
    setThemeInput,
    addTheme,
    addWordsToTheme,
    removeTheme,
    moveTheme,
    toggleCustomTheme,
    removeWord,
    toggleBuiltinSet,
    resetBuiltinSet,
  } = useHotwordsManager()

  const themeSortable = useSortable({ onMove: (from, to) => void moveTheme(from, to) })

  const handleExport = async () => {
    const result = await exportHotwords()
    setExportMessage(result.canceled ? t('history.exportCanceled') : t('history.savedTo', { path: result.filePath ?? '' }))
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">{t('nav.hotwords')}</h1>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setTab('hotwords')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'hotwords' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('dict.tabHotwords')}</button>
            <button
              type="button"
              onClick={() => setTab('replacement')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'replacement' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('dict.tabTextProcess')}</button>
          </div>
        </div>

        {tab === 'hotwords' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {hotwords.length} / {MAX_HOTWORDS}
            </span>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('dict.searchPlaceholder')}
                className="w-52 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
              />
            </div>
            <Tooltip content={t('history.export')}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                onClick={() => void handleExport()}
                aria-label={t('history.export')}
              >
                <Download className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>

      {exportMessage && tab === 'hotwords' && (
        <p className="mb-2 text-sm text-muted-foreground">{exportMessage}</p>
      )}

      {tab === 'replacement' && (
        <>
          <TextFormatSection />
          <TextReplacementSection />
        </>
      )}

      {tab === 'hotwords' && (
        <>
          <p className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>{t('dict.intro')}</span>
            <Tooltip
              variant="light"
              content={
                <p className="max-w-[380px] text-left leading-relaxed">
                  <RichText text={t('dict.caveat')} />
                </p>
              }
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
            </Tooltip>
          </p>

          <HotwordDeliveryNotice hotwordCount={hotwords.length} />

          {hotwords.length > HOTWORD_SOFT_LIMIT && !warnDismissed && (
            <div className="mb-4 -mt-2 flex items-start gap-2 text-xs text-amber-500">
              <p>
                <RichText text={t('dict.countHint', { count: hotwords.length })} />
              </p>
              <button
                type="button"
                onClick={() => setWarnDismissed(true)}
                className="shrink-0 rounded p-0.5 text-amber-500/70 transition-colors hover:bg-amber-500/10 hover:text-amber-500"
                aria-label={t('dict.dismissHint')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          <div className="mb-4 flex items-center gap-2">
            <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void addTheme()
                }
              }}
              placeholder={t('dict.newCategoryPlaceholder')}
              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
            />
            <Button
              onClick={() => void addTheme()}
              size="sm"
              variant="outline"
              disabled={!newThemeName.trim()}
              className="shrink-0 gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('dict.add')}
            </Button>
          </div>

          {loading ? (
            <p className="py-8 text-center text-muted-foreground">{t('dict.loading')}</p>
          ) : (
            <div className="space-y-4">
              {customThemes.length > 1 && !search && (
                <p className="text-xs text-muted-foreground/70">
                  {t('dict.orderHint')}
                </p>
              )}
              {visibleCustomThemes.map((theme, themeIndex) => {
                const canSort = !search && customThemes.length > 1
                const active = !!customThemeActive[theme.id]
                const activeWords = getThemeWordsInHotwords(theme)
                const totalWords = theme.words.length

                return (
                  <Card
                    key={theme.id}
                    {...(canSort ? themeSortable.rowProps(themeIndex) : {})}
                    className={cn('group', !active && 'border-dashed opacity-70', canSort && themeSortable.rowClassName(themeIndex))}
                  >
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {canSort && <DragHandle {...themeSortable.handleProps(themeIndex, t('dict.dragCategory', { name: theme.name }))} />}
                          <Switch
                            checked={active}
                            onChange={() => void toggleCustomTheme(theme.id)}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{theme.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('dict.customCount', { active: activeWords.length, total: totalWords })}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Tooltip content={t('dict.deleteCategory')}>
                            <button
                              type="button"
                              onClick={() => void removeTheme(theme.id)}
                              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              aria-label={t('dict.deleteTheme', { name: theme.name })}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      </div>

                      {active && (
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            <input
                              value={themeInputs[theme.id] || ''}
                              onChange={(e) => setThemeInput(theme.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  void addWordsToTheme(theme.id)
                                }
                              }}
                              placeholder={t('dict.addWordsPlaceholder')}
                              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                            />
                            <Button
                              onClick={() => void addWordsToTheme(theme.id)}
                              size="sm"
                              variant="outline"
                              disabled={!(themeInputs[theme.id] || '').trim()}
                              className="shrink-0 gap-1.5"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('dict.add')}
                            </Button>
                          </div>

                          {activeWords.length > 0 && (
                            <WordChips words={activeWords} onRemove={removeWord} expandAll={!!search} />
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {Object.entries(BUILTIN_SETS).map(([key, setDef]) => {
                const active = !!builtinSetActive[key]
                const activeWords = getSetWordsInHotwords(key)
                const totalWords = (builtinSetWords[key] || []).length

                if (search && activeWords.length === 0 && !setDef.label.toLowerCase().includes(search.toLowerCase())) {
                  return null
                }

                return (
                  <Card key={key} className={cn(!active && 'border-dashed opacity-70')}>
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={active}
                            onChange={() => void toggleBuiltinSet(key)}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{setDef.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('dict.builtinCount', { desc: setDef.description, active: activeWords.length, total: totalWords })}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 text-xs"
                          onClick={() => void resetBuiltinSet(key)}
                        >
                          <RotateCcw className="h-3 w-3" /> {t('dict.reset')}
                        </Button>
                      </div>

                      {active && activeWords.length > 0 && (
                        <WordChips words={activeWords} onRemove={removeWord} expandAll={!!search} />
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {filteredUnknown.length > 0 && (
                <Card>
                  <CardContent className="p-4">
                    <button
                      className="mb-2 flex w-full items-center justify-between text-left"
                      onClick={() => setShowUnknown(!showUnknown)}
                    >
                      <div>
                        <p className="text-sm font-medium">{t('dict.legacyTitle')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('dict.legacyDesc')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{filteredUnknown.length}</span>
                        {showUnknown ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>

                    {showUnknown && (
                      <WordChips words={filteredUnknown} onRemove={removeWord} expandAll={!!search} />
                    )}
                  </CardContent>
                </Card>
              )}

              {!search && hotwords.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('dict.empty')}
                  </p>
                </div>
              )}

              {search && filtered.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">{t('dict.noMatch')}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
