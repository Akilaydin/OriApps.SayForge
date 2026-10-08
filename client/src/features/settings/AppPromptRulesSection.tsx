import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2, Crosshair } from 'lucide-react'
import * as bridge from '@/services/bridge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { cn } from '@/lib/utils'
import type { PromptPreset } from '@/services/store'
import type { AppPromptRule } from '@/services/personalization/types'
import { useT } from '@/i18n/useT'
import { appPromptRuleDisplayName, promptPresetDisplayName } from '@/i18n/displayNames'

const DETECT_COUNTDOWN_SEC = 5

function formatMatcher(rule: AppPromptRule, t: ReturnType<typeof useT>) {
  if (rule.matcher.processNames.length > 0) {
    return t('appPrompt.matcherProcess', { value: rule.matcher.processNames.join(', ') })
  }
  const parts: string[] = []
  if (rule.matcher.windowTitleIncludes?.length) {
    parts.push(t('appPrompt.matcherWindow', { value: rule.matcher.windowTitleIncludes.join(', ') }))
  }
  if (rule.matcher.windowClasses?.length) {
    parts.push(t('appPrompt.matcherClass', { value: rule.matcher.windowClasses.join(', ') }))
  }
  if (rule.matcher.automationIds?.length) {
    parts.push(t('appPrompt.matcherControl', { value: rule.matcher.automationIds.join(', ') }))
  }
  return parts.join(' | ')
}

function isSameRule(left: AppPromptRule, right: AppPromptRule) {
  return JSON.stringify(left) === JSON.stringify(right)
}

type DetectHint =
  | { kind: 'missing' | 'sayit' | 'failed' }
  | { kind: 'found'; process: string; title: string }
  | null

export default function AppPromptRulesSection({
  presets,
  rules,
  onSaveRule,
  onToggleRule,
  onMoveRule,
  onResetRule,
  onCreateRule,
  onDeleteRule,
}: {
  presets: PromptPreset[]
  rules: AppPromptRule[]
  onSaveRule: (rule: AppPromptRule) => Promise<void> | void
  onToggleRule: (ruleId: string, enabled: boolean) => Promise<void> | void
  onMoveRule: (from: number, to: number) => Promise<void> | void
  onResetRule: (ruleId: string) => Promise<void> | void
  onCreateRule: (draft: { name: string; processNames: string[]; presetId?: string; promptAppend: string }) => Promise<void> | void
  onDeleteRule: (ruleId: string) => Promise<void> | void
}) {
  const t = useT()
  const [drafts, setDrafts] = useState<Record<string, AppPromptRule>>({})
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | null>(null)
  const [newRule, setNewRule] = useState<{ name: string; processName: string; presetId: string; promptAppend: string } | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [detectHint, setDetectHint] = useState<DetectHint>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const savedSnapshot = useRef<Record<string, AppPromptRule>>({})
  const expansionInitialized = useRef(false)

  const canSort = rules.length > 1
  const ruleSortable = useSortable({ onMove: (from, to) => void onMoveRule(from, to) })

  useEffect(() => {
    setDrafts((current) => {
      const nextDrafts: Record<string, AppPromptRule> = {}
      for (const rule of rules) {
        const previous = savedSnapshot.current[rule.id]
        const draft = current[rule.id]
        const contentChanged = !previous || !isSameRule({ ...previous, enabled: rule.enabled }, rule)
        nextDrafts[rule.id] = draft && !contentChanged
          ? { ...draft, enabled: rule.enabled }
          : { ...rule, matcher: { ...rule.matcher } }
      }
      return nextDrafts
    })
    savedSnapshot.current = Object.fromEntries(rules.map((rule) => [rule.id, rule]))

    if (!expansionInitialized.current && rules.length > 0) {
      expansionInitialized.current = true
      setExpandedRules(new Set(rules.filter((rule) => rule.enabled).map((rule) => rule.id)))
    }
  }, [rules])

  const presetOptions = [
    { id: '', name: t('appPrompt.inheritGlobal') },
    ...presets.map((preset) => ({ id: preset.id, name: promptPresetDisplayName(preset) })),
  ]

  const updateDraft = (ruleId: string, patch: Partial<AppPromptRule>) => {
    setDrafts((current) => {
      const existing = current[ruleId]
      if (!existing) return current
      return {
        ...current,
        [ruleId]: {
          ...existing,
          ...patch,
        },
      }
    })
  }

  const handleToggle = (rule: AppPromptRule) => {
    const enabled = !rule.enabled
    setExpandedRules((current) => {
      const next = new Set(current)
      if (enabled) next.add(rule.id)
      else next.delete(rule.id)
      return next
    })
    void onToggleRule(rule.id, enabled)
  }

  const toggleExpanded = (ruleId: string) => {
    setExpandedRules((current) => {
      const next = new Set(current)
      if (next.has(ruleId)) {
        next.delete(ruleId)
      } else {
        next.add(ruleId)
      }
      return next
    })
  }

  const detectCurrentApp = async () => {
    setDetectHint(null)
    for (let s = DETECT_COUNTDOWN_SEC; s > 0; s -= 1) {
      setCountdown(s)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    setCountdown(0)
    try {
      const ctx = await bridge.getActiveAppContext()
      const raw = String((ctx?.processName as string) || '').trim()
      if (!raw) {
        setDetectHint({ kind: 'missing' })
        return
      }
      if (raw.toLowerCase() === 'sayforge.exe') {
        setDetectHint({ kind: 'sayit' })
        return
      }
      setNewRule((current) => (current ? { ...current, processName: raw } : current))
      const title = String((ctx?.windowTitle as string) || '').trim()
      setDetectHint({ kind: 'found', process: raw, title })
    } catch {
      setDetectHint({ kind: 'failed' })
    }
  }

  const handleCreate = async () => {
    if (!newRule) return
    const name = newRule.name.trim()
    const processNames = newRule.processName
      .split(/[,\uFF0C\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!name || processNames.length === 0) return
    await onCreateRule({
      name,
      processNames,
      presetId: newRule.presetId || undefined,
      promptAppend: newRule.promptAppend.trim(),
    })
    setNewRule(null)
    setDetectHint(null)
  }

  const handleSave = async (ruleId: string) => {
    const draft = drafts[ruleId]
    if (!draft) return
    setSavingId(ruleId)
    try {
      await onSaveRule(draft)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t('appPrompt.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('appPrompt.desc')}
            </p>
            {canSort && (
              <p className="mt-1.5 text-xs text-muted-foreground/70">
                {t('appPrompt.orderHint')}
              </p>
            )}
          </div>
          {!newRule && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => { setNewRule({ name: '', processName: '', presetId: '', promptAppend: '' }); setDetectHint(null) }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('appPrompt.newRule')}
            </Button>
          )}
        </div>

        {newRule && (
          <div className="rounded-lg border border-dashed p-4">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t('appPrompt.appName')}</label>
                  <input
                    value={newRule.name}
                    onChange={(event) => setNewRule({ ...newRule, name: event.target.value })}
                    placeholder={t('appPrompt.appNamePlaceholder')}
                    className="w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t('appPrompt.processName')}</label>
                  <div className="flex gap-2">
                    <input
                      value={newRule.processName}
                      onChange={(event) => setNewRule({ ...newRule, processName: event.target.value })}
                      placeholder={t('appPrompt.processPlaceholder')}
                      className="w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      disabled={countdown > 0}
                      onClick={() => void detectCurrentApp()}
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                      {countdown > 0 ? t('appPrompt.detectCountdown', { seconds: countdown }) : t('appPrompt.detectCurrent')}
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {countdown > 0
                  ? t('appPrompt.switchHint')
                  : detectHint?.kind === 'found'
                    ? t('appPrompt.detectFound', {
                      process: detectHint.process,
                      title: detectHint.title ? t('appPrompt.detectTitle', { title: detectHint.title }) : '',
                    })
                    : detectHint
                      ? t(detectHint.kind === 'sayit'
                        ? 'appPrompt.detectSayIt'
                        : detectHint.kind === 'missing' ? 'appPrompt.detectMissing' : 'appPrompt.detectFailed')
                      : t('appPrompt.detectHint', { seconds: DETECT_COUNTDOWN_SEC })}
              </p>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('appPrompt.basePreset')}</label>
                <Select
                  value={newRule.presetId}
                  onChange={(value) => setNewRule({ ...newRule, presetId: value })}
                  options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('appPrompt.appendPrompt')}</label>
                <textarea
                  value={newRule.promptAppend}
                  onChange={(event) => setNewRule({ ...newRule, promptAppend: event.target.value })}
                  rows={2}
                  className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                  placeholder={t('appPrompt.appendPlaceholderNew')}
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setNewRule(null); setDetectHint(null) }}
                  className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                >
                  {t('appPrompt.cancel')}
                </button>
                <button
                  disabled={!newRule.name.trim() || !newRule.processName.trim()}
                  onClick={() => void handleCreate()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {t('appPrompt.add')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {rules.map((rule, index) => {
            const draft = drafts[rule.id] || rule
            const dirty = !isSameRule(draft, rule)
            const isExpanded = expandedRules.has(rule.id)

            return (
              <div
                key={rule.id}
                {...(canSort ? ruleSortable.rowProps(index) : {})}
                className={cn('group rounded-lg border bg-card', canSort && ruleSortable.rowClassName(index))}
              >
                <div
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-t-lg bg-muted/30 px-4 py-2.5"
                  onClick={() => toggleExpanded(rule.id)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {canSort && (
                      <DragHandle
                        {...ruleSortable.handleProps(index, t('appPrompt.drag', { name: appPromptRuleDisplayName(rule) }))}
                        onClick={(event) => event.stopPropagation()}
                      />
                    )}
                    <div className="shrink-0">
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>

                    <p className="text-sm font-medium">{appPromptRuleDisplayName(rule)}</p>
                    <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground/50">{rule.builtin ? t('appPrompt.builtin') : t('appPrompt.custom')}</span>
                    <p className="ml-1 truncate text-xs text-muted-foreground/50">{formatMatcher(rule, t)}</p>
                  </div>

                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                    />
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t px-4 pb-3 pt-3">
                    <div className="space-y-3">
                      {!rule.builtin && (
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-foreground">{t('appPrompt.processName')}</label>
                          <input
                            value={(draft.matcher.processNames || []).join(', ')}
                            onChange={(event) => updateDraft(rule.id, {
                              matcher: {
                                ...draft.matcher,
                                processNames: event.target.value.split(/[,\uFF0C\s]+/).map((s) => s.trim()).filter(Boolean),
                              },
                            })}
                            placeholder={t('appPrompt.processPlaceholder')}
                            className="w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">{t('appPrompt.basePreset')}</label>
                        <Select
                          value={draft.presetId || ''}
                          onChange={(value) => updateDraft(rule.id, { presetId: value || undefined })}
                          options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">{t('appPrompt.appendPrompt')}</label>
                        <textarea
                          value={draft.promptAppend}
                          onChange={(event) => updateDraft(rule.id, { promptAppend: event.target.value })}
                          rows={1}
                          className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                          style={{ fieldSizing: 'content' as never, minHeight: '2.25rem', maxHeight: '7rem' }}
                          placeholder={t('appPrompt.appendPlaceholder')}
                        />
                      </div>

                      <div className="flex justify-end gap-2">
                        {rule.builtin ? (
                          <button
                            onClick={() => void onResetRule(rule.id)}
                            className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                          >
                            {t('appPrompt.restoreDefault')}
                          </button>
                        ) : deletingId === rule.id ? (
                          <>
                            <button
                              onClick={() => setDeletingId(null)}
                              className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                            >
                              {t('appPrompt.cancel')}
                            </button>
                            <button
                              onClick={() => { setDeletingId(null); void onDeleteRule(rule.id) }}
                              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground transition-colors hover:bg-destructive/90"
                            >
                              {t('appPrompt.confirmDelete')}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeletingId(rule.id)}
                            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('appPrompt.delete')}
                          </button>
                        )}
                        <button
                          disabled={!dirty || savingId === rule.id}
                          onClick={() => void handleSave(rule.id)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {savingId === rule.id ? t('appPrompt.saving') : t('appPrompt.saveRule')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
