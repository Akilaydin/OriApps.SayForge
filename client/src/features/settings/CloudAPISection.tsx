//
//
//

import { useEffect, useRef, useState } from 'react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { CheckCircle2, ExternalLink, Info, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { asrConfigFromProfile } from '@/services/transcription/asrConfig'
import { prepareTestPcm, testCloudAsr } from '@/services/transcription/asrTest'
import { describeProviderError } from '@/lib/errorMessages'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrAvailabilityLabel,
  asrModelsOf,
  describeAsrMissing,
  effectiveAsrCredentials,
  emptyAsrProfile,
  findAsrProvider,
  gradeAsrLatency,
  groupAsrModelsByVendor,
  ASR_COMPAT_PROTOCOLS,
  asrCardTitle,
  asrEndpointHost,
  parseAsrCompatProtocol,
  parseAsrAudioEncoding,
  resolveAsrModel,
  resolveAsrModelOption,
  type AsrCheck,
  type AsrProfile,
} from './asrProviderCatalog'
import { loadAsrProfiles, saveAsrProfiles } from './asrProfileStore'
import { formatCheckedAt, formatLatency, isCheckFresh } from './aiProviderCatalog'
import { t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'
const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm transition-colors focus:border-input-focus-border'
const linkClass = 'inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary'
const cardIconButtonClass = 'pointer-events-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground'

interface Notice {
  tone: FeedbackTone
  message: string
  detail?: string
}

type AsrTestOutcome =
  | { ok: true; check: AsrCheck; text: string; latencyMs: number; audioSec: number }
  | { ok: false; check: AsrCheck; message: string; detail?: string }

async function runAsrTest(
  profile: AsrProfile,
  audio: { pcmB64: string; audioSec: number },
): Promise<AsrTestOutcome> {
  const entry = findAsrProvider(profile.provider)
  if (!entry) {
    return { ok: false, check: { ok: false, at: Date.now(), reason: t('asr.err.unknownProvider') }, message: t('asr.err.unknownProvider') }
  }
  try {
    const { text, latencyMs } = await testCloudAsr(asrConfigFromProfile(profile), audio)
    if (!text) {
      return {
        ok: false,
        check: { ok: false, at: Date.now(), reason: t('asr.err.emptyText') },
        message: t('asr.msg.emptyText'),
      }
    }
    return {
      ok: true,
      check: { ok: true, at: Date.now(), latencyMs, audioSec: audio.audioSec },
      text,
      latencyMs,
      audioSec: audio.audioSec,
    }
  } catch (err) {
    const friendly = describeProviderError(err)
    return {
      ok: false,
      check: { ok: false, at: Date.now(), reason: friendly.message },
      message: t('asr.msg.testFailed', { message: friendly.message }),
      detail: friendly.detail,
    }
  }
}


export default function CloudAPISection() {
  useT()
  const mounted = useRef(false)
  const testBusy = useRef(false)
  const testGeneration = useRef(0)
  const [profiles, setProfiles] = useState<AsrProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState('')
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [testingIds, setTestingIds] = useState<string[]>([])

  const [draft, setDraft] = useState<AsrProfile | null>(null)
  const [draftIsNew, setDraftIsNew] = useState(false)
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)

  const busy = testingId !== '' || saving || batch !== null
  const isTesting = (id: string) => testingId === id || testingIds.includes(id)
  const draftEntry = draft ? findAsrProvider(draft.provider) : undefined
  const draftPlatform = draftEntry?.platform ?? 'openai_compat'
  const draftDirty = draft !== null && JSON.stringify(draft) !== draftBaseline
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOfPlatform(draft.provider, draft.id)?.apiKey === draft.apiKey

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; testGeneration.current++; setEngineDraftDirty(false) }
  }, [])

  async function load() {
    const state = await loadAsrProfiles()
    if (!mounted.current) return
    setProfiles(state.profiles)
    setActiveId(state.activeId)
    setLoaded(true)
  }

  function lastProfileOfPlatform(providerId: string, excludeId?: string): AsrProfile | undefined {
    const platform = findAsrProvider(providerId)?.platform
    if (!platform) return undefined
    return [...profiles]
      .reverse()
      .find((p) => p.id !== excludeId && findAsrProvider(p.provider)?.platform === platform)
  }

  async function persist(next: AsrProfile[], nextActiveId: string) {
    setProfiles(next)
    setActiveId(nextActiveId)
    await saveAsrProfiles({ profiles: next, activeId: nextActiveId })
    void refreshModeStatus()
  }

  async function handleActivate(id: string) {
    if (id === activeId) return
    setNotice(null)
    await persist(profiles, id)
  }


  async function handleTest(profile: AsrProfile, isDraft = false) {
    if (busy || testBusy.current) return
    const entry = findAsrProvider(profile.provider)
    if (!entry) return
    const missing = describeAsrMissing(profile)
    if (missing) {
      setNotice({ tone: 'warning', message: t('asr.msg.missingBeforeTest', { label: entry.label, missing }) })
      return
    }
    testBusy.current = true
    const generation = ++testGeneration.current
    const current = () => mounted.current && generation === testGeneration.current
    setTestingId(profile.id)
    setNotice(null)
    try {
      const audio = await prepareTestPcm()
      if (!current()) return
      const outcome = await runAsrTest(profile, audio)
      if (!current()) return
      if (!isDraft) await persist(
        profiles.map((p) => (p.id === profile.id ? { ...p, check: outcome.check } : p)),
        activeId,
      )
      if (!current()) return
      if (!outcome.ok) {
        setNotice({ tone: 'error', message: `${entry.label} ${outcome.message}`, detail: outcome.detail })
        return
      }
      const grade = gradeAsrLatency(outcome.latencyMs, outcome.audioSec)
      setNotice({
        tone: grade.tone === 'bad' ? 'warning' : 'success',
        message: t('asr.msg.testOk', { label: entry.label, sec: outcome.audioSec.toFixed(1), latency: formatLatency(outcome.latencyMs), grade: grade.label }),
        detail: t('asr.msg.testDetail', { text: outcome.text }),
      })
    } catch (err) {
      const friendly = describeProviderError(err)
      if (!current()) return
      setNotice({ tone: 'error', message: t('asr.msg.testCrashed', { label: entry.label, message: friendly.message }), detail: friendly.detail })
    } finally {
      testBusy.current = false
      if (mounted.current) setTestingId('')
    }
  }

  async function handleTestAll() {
    if (busy || testBusy.current) return
    const targets = profiles.filter((p) => !describeAsrMissing(p))
    const skipped = profiles.length - targets.length
    if (targets.length === 0) {
      setNotice({
        tone: 'warning',
        message: t('asr.msg.nothingToTest'),
      })
      return
    }

    testBusy.current = true
    const generation = ++testGeneration.current
    const current = () => mounted.current && generation === testGeneration.current
    setNotice(null)
    setBatch({ done: 0, total: targets.length })
    setTestingIds(targets.map((p) => p.id))

    try {
      const audio = await prepareTestPcm()
      if (!current()) return
      let done = 0
      const results = await Promise.all(targets.map(async (target) => {
        const outcome = await runAsrTest(target, audio)
        done += 1
        if (!current()) return { target, outcome }
        setBatch({ done, total: targets.length })
        setTestingIds((prev) => prev.filter((id) => id !== target.id))
        return { target, outcome }
      }))

      if (!current()) return
      const checks = new Map(results.map((r) => [r.target.id, r.outcome.check]))
      await persist(
        profiles.map((p) => {
          const check = checks.get(p.id)
          return check ? { ...p, check } : p
        }),
        activeId,
      )

      if (!current()) return
      let okCount = 0
      let failCount = 0
      const lines = results.map(({ target, outcome }) => {
        const label = findAsrProvider(target.provider)?.label ?? target.provider
        if (outcome.ok) {
          okCount += 1
          const grade = gradeAsrLatency(outcome.latencyMs, outcome.audioSec)
          return t('asr.msg.batchLine', { label, latency: formatLatency(outcome.latencyMs), grade: grade.label })
        }
        failCount += 1
        return `${label}: ${outcome.message}`
      })

      const parts = [t('asr.msg.batchOk', { count: okCount })]
      if (failCount > 0) parts.push(t('asr.msg.batchFail', { count: failCount }))
      if (skipped > 0) parts.push(t('asr.msg.batchSkipped', { count: skipped }))
      if (targets.length > 1) {
        lines.push('', t('asr.msg.batchNote'))
      }
      setNotice({
        tone: failCount > 0 ? 'warning' : 'success',
        message: t('asr.msg.batchDone', { parts: parts.join(t('asr.listSeparator')) }),
        detail: lines.join('\n'),
      })
    } catch (err) {
      const friendly = describeProviderError(err)
      if (!current()) return
      setNotice({ tone: 'error', message: t('asr.msg.batchCrashed', { message: friendly.message }), detail: friendly.detail })
    } finally {
      testBusy.current = false
      if (mounted.current) { setTestingIds([]); setBatch(null) }
    }
  }


  function openEditor(profile: AsrProfile, isNew: boolean) {
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftBaseline(JSON.stringify(profile))
    setNotice(null)
  }

  function handleNew() {
    const fresh = emptyAsrProfile()
    const prev = lastProfileOfPlatform(fresh.provider, fresh.id)
    if (prev) {
      fresh.apiKey = prev.apiKey
    }
    openEditor(fresh, true)
  }

  function closeEditor() {
    if (saving) return
    testGeneration.current++
    setNotice(null)
    setDraft(null)
    setEngineDraftDirty(false)
  }

  function patchDraft(next: Partial<AsrProfile>) {
    if (!draft) return
    testGeneration.current++
    setNotice(null)
    const merged = { ...draft, ...next }
    setDraft(merged)
    setEngineDraftDirty(JSON.stringify(merged) !== draftBaseline)
  }

  function handleDraftProvider(providerId: string) {
    if (!draft) return
    const nextPlatform = findAsrProvider(providerId)?.platform
    const prevPlatform = findAsrProvider(draft.provider)?.platform
    const nextModel = asrModelsOf(findAsrProvider(providerId)!)[0].id
    if (nextPlatform === prevPlatform) {
      patchDraft({ provider: providerId, model: nextModel })
      return
    }
    const prev = lastProfileOfPlatform(providerId, draft.id)
    patchDraft({
      provider: providerId,
      model: nextModel,
      apiKey: prev?.apiKey ?? '',
    })
  }

  async function handleSaveDraft() {
    if (!draft || saving || testBusy.current) return
    setSaving(true)
    try {
      const before = profiles.find((p) => p.id === draft.id)
      const credsChanged = !before
        || JSON.stringify(effectiveAsrCredentials(before)) !== JSON.stringify(effectiveAsrCredentials(draft))
      const saved: AsrProfile = { ...draft, check: credsChanged ? undefined : before?.check }

      const next = draftIsNew
        ? [...profiles, saved]
        : profiles.map((p) => (p.id === saved.id ? saved : p))
      await persist(next, draftIsNew ? saved.id : activeId)

      setDraft(null)
      setEngineDraftDirty(false)
      const missing = describeAsrMissing(saved)
      setNotice(missing
        ? { tone: 'warning', message: t('asr.msg.savedWithMissing', { missing }) }
        : { tone: 'success', message: t('asr.msg.saved') })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    const next = profiles.filter((p) => p.id !== id)
    await persist(next, id === activeId ? (next[0]?.id ?? '') : activeId)
    setPendingDeleteId('')
    setNotice(null)
  }


  interface CardStatus {
    label: string
    tone: 'neutral' | 'ok' | 'warn' | 'bad'
    spoken: string
    hint: string
    needsSetup?: boolean
  }

  function describeCard(profile: AsrProfile): CardStatus {
    if (isTesting(profile.id)) {
      return { label: t('asr.status.testing'), tone: 'neutral', spoken: t('asr.status.testingSpoken'), hint: t('asr.status.testingHint') }
    }
    const missing = describeAsrMissing(profile)
    if (missing) {
      return { label: t('asr.status.needsSetup'), tone: 'warn', spoken: missing, hint: missing, needsSetup: true }
    }
    const check = profile.check
    if (!check) {
      return { label: t('asr.status.untested'), tone: 'neutral', spoken: t('asr.status.untestedSpoken'), hint: t('asr.status.untestedHint') }
    }
    if (!check.ok) {
      const reason = check.reason ?? t('common.unknownReason')
      return {
        label: t('asr.status.unavailable'),
        tone: 'bad',
        spoken: t('asr.status.unavailableSpoken', { reason }),
        hint: t('asr.status.unavailableHint', { when: formatCheckedAt(check.at), reason }),
      }
    }
    const fresh = isCheckFresh(check)
    const ms = check.latencyMs
    if (ms === undefined) {
      return { label: t('asr.status.available'), tone: fresh ? 'ok' : 'neutral', spoken: t('asr.status.available'), hint: t('asr.status.availableHint', { when: formatCheckedAt(check.at) }) }
    }
    const grade = gradeAsrLatency(ms, check.audioSec ?? 0)
    return {
      label: formatLatency(ms),
      tone: fresh ? grade.tone : 'neutral',
      spoken: t('asr.status.availableSpoken', { grade: grade.label, latency: formatLatency(ms) }),
      hint: t('asr.status.availableDetailHint', {
        when: formatCheckedAt(check.at),
        sec: (check.audioSec ?? 0).toFixed(1),
        latency: formatLatency(ms),
        grade: grade.label,
        stale: fresh ? '' : t('asr.staleSuffix'),
      }),
    }
  }

  const chipToneClass: Record<CardStatus['tone'], string> = {
    neutral: 'bg-muted text-muted-foreground',
    ok: 'bg-success/10 text-success-strong',
    warn: 'bg-warning/10 text-warning-strong',
    bad: 'bg-destructive/10 text-destructive',
  }

  function renderCard(profile: AsrProfile) {
    const entry = findAsrProvider(profile.provider)
    if (!entry) return null
    const isActive = profile.id === activeId
    const status = describeCard(profile)
    const siblings = profiles.filter((p) => p.provider === profile.provider).length
    const title = asrCardTitle(profile, siblings)
    const availability = asrAvailabilityLabel(entry)
    //
    const option = resolveAsrModelOption(profile)
    const model = option ? option.id : resolveAsrModel(profile)
    const host = asrEndpointHost(profile)
    const modelLine = host ? `${model} · ${host}` : model
    return (
      <div
        key={profile.id}
        className={cn(
          'group relative rounded-lg border p-2.5 transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        )}
      >
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          aria-label={t('common.cardStatusAria', { title, subtitle: model, status: status.spoken })}
          onClick={() => void handleActivate(profile.id)}
          className="absolute inset-0 rounded-lg"
        />
        <div className="flex items-center gap-1.5">
          {isActive && (
            <Tooltip className="pointer-events-auto relative z-10 shrink-0" content={t('common.inUse')}>
              <CheckCircle2 className="h-4 w-4 shrink-0 cursor-help text-success-strong" aria-label={t('common.inUse')} />
            </Tooltip>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</span>
          <Tooltip className="pointer-events-auto relative z-10 shrink-0" variant="light" content={status.hint}>
            <span className={cn('cursor-help rounded-full px-2 py-0.5 text-[11px] font-medium', chipToneClass[status.tone])}>
              {status.label}
            </span>
          </Tooltip>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={modelLine}>
            {modelLine}
          </span>
          <div
            className={cn(
              'pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
              status.needsSetup ? 'opacity-100' : 'opacity-0',
            )}
          >
            <Tooltip className="pointer-events-auto" content={t('common.test')}>
              <button
                type="button"
                onClick={() => void handleTest(profile)}
                disabled={busy}
                aria-label={t('asr.testAria', { title })}
                className={cardIconButtonClass}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isTesting(profile.id) && 'animate-spin')} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.edit')}>
              <button
                type="button"
                onClick={() => openEditor({ ...profile }, false)}
                aria-label={t('asr.editAria', { title })}
                className={cardIconButtonClass}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.delete')}>
              <button
                type="button"
                onClick={() => setPendingDeleteId(profile.id)}
                disabled={busy}
                aria-label={t('asr.deleteAria', { title })}
                className={cardIconButtonClass}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
          {entry.blurb}
          {availability !== '' && <> <span className="font-medium">{availability}</span></>}
        </p>
      </div>
    )
  }


  function renderEditor() {
    if (!draft) return null
    const platformInfo = ASR_PLATFORMS[draftPlatform]
    const draftEntry = findAsrProvider(draft.provider)
    const draftAvailability = draftEntry ? asrAvailabilityLabel(draftEntry) : ''
    const draftModels = draftEntry ? asrModelsOf(draftEntry) : []
    const draftModelGroups = groupAsrModelsByVendor(draftModels)
    const draftModelOption = resolveAsrModelOption(draft)
    const keyLabel = 'API Key'
    return (
      <Modal
        title={draftIsNew ? t('asr.editorNew') : t('asr.editorEdit')}
        onClose={closeEditor}
        locked={saving}
        showCloseButton
        panelClassName="w-[520px]"
      >
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="asr-provider" className="mb-1 block text-sm text-muted-foreground">{t('asr.provider')}</label>
            <select
              id="asr-provider"
              value={draft.provider}
              onChange={(e) => handleDraftProvider(e.target.value)}
              className={selectClass}
            >
              {ASR_PROVIDERS.map((p) => {
                const models = asrModelsOf(p)
                const showModel = models.length === 1 && !p.customEndpoint
                return (
                  <option key={p.id} value={p.id}>
                    {showModel ? `${p.label} · ${models[0].id}` : p.label}
                  </option>
                )
              })}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {draftEntry?.blurb}
              {draftAvailability !== '' && <> <span className="font-medium">{draftAvailability}</span></>}
            </p>
          </div>

          <div>
            <label htmlFor="asr-name" className="mb-1 block text-sm text-muted-foreground">
              {t('asr.cardName')}
            </label>
            <input
              id="asr-name"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
              placeholder={draftEntry?.label ?? ''}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('asr.cardNameHint')}</p>
          </div>

          {draftModelOption?.supportsCustomUrl && (
            <div>
              <label htmlFor="asr-api-url" className="mb-1 block text-sm text-muted-foreground">
                {draftModelOption.requiresCustomUrl ? t('asr.apiUrl') : t('asr.apiUrlOptional')}
              </label>
              <input
                id="asr-api-url"
                type="url"
                inputMode="url"
                value={draft.apiUrl}
                onChange={(e) => patchDraft({ apiUrl: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder={draftEntry?.urlPlaceholder ?? ''}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {draftModelOption.requiresCustomUrl ? t('asr.apiUrlHint') : t('asr.apiUrlOptionalHint')}
              </p>
            </div>
          )}

          {draftEntry?.customEndpoint && (
            <div>
              <label htmlFor="asr-protocol" className="mb-1 block text-sm text-muted-foreground">
                {t('asr.protocol')}
              </label>
              <select
                id="asr-protocol"
                value={draft.protocol}
                onChange={(e) => patchDraft({ protocol: parseAsrCompatProtocol(e.target.value) })}
                className={selectClass}
              >
                {ASR_COMPAT_PROTOCOLS.map((value) => (
                  <option key={value} value={value}>{t(`asr.protocol.${value}`)}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">{t('asr.protocolHint')}</p>
            </div>
          )}

          {draftEntry?.id === 'openai_compat' && (
            <>
              <div>
                <label htmlFor="asr-audio-encoding" className="mb-1 block text-sm text-muted-foreground">{t('asr.audioEncoding')}</label>
                <select
                  id="asr-audio-encoding"
                  className={selectClass}
                  value={draft.audioEncoding}
                  onChange={(e) => patchDraft({ audioEncoding: parseAsrAudioEncoding(e.target.value) })}
                >
                  <option value="mp3">MP3 (64 kbps, mono)</option>
                  <option value="wav">WAV (lossless compatibility)</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">{t('asr.audioEncodingHint')}</p>
              </div>
              <div>
                <label htmlFor="asr-system-instruction" className="mb-1 block text-sm text-muted-foreground">{t('asr.systemInstruction')}</label>
                <textarea
                  id="asr-system-instruction"
                  value={draft.systemInstruction}
                  onChange={(e) => patchDraft({ systemInstruction: e.target.value })}
                  placeholder={t('asr.systemInstructionPlaceholder')}
                  rows={3}
                  className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('asr.systemInstructionHint')}</p>
              </div>
              <div>
                <label htmlFor="asr-user-prompt" className="mb-1 block text-sm text-muted-foreground">{t('asr.userPrompt')}</label>
                <textarea
                  id="asr-user-prompt"
                  value={draft.userPrompt}
                  onChange={(e) => patchDraft({ userPrompt: e.target.value })}
                  placeholder={t('asr.userPromptPlaceholder')}
                  rows={2}
                  className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('asr.userPromptHint')}</p>
              </div>
            </>
          )}

          {draftEntry?.customEndpoint && (
            <div>
              <label htmlFor="asr-model-text" className="mb-1 block text-sm text-muted-foreground">
                {t('asr.model')}
              </label>
              <input
                id="asr-model-text"
                value={draft.model}
                onChange={(e) => patchDraft({ model: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder={draftModels[0]?.id ?? ''}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('asr.modelFreeTextHint')}</p>
            </div>
          )}

          {draftModels.length > 1 && (
            <div>
              <label htmlFor="asr-model" className="mb-1 block text-sm text-muted-foreground">{t('asr.model')}</label>
              <select
                id="asr-model"
                value={resolveAsrModel(draft)}
                onChange={(e) => patchDraft({ model: e.target.value })}
                className={selectClass}
              >
                {draftModelGroups
                  ? draftModelGroups.map(([vendor, models]) => (
                    <optgroup key={vendor} label={vendor}>
                      {models.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id === draftModels[0].id
                            ? t('asr.modelDefaultOption', { model: option.id })
                            : option.id}
                        </option>
                      ))}
                    </optgroup>
                  ))
                  : draftModels.map((option, index) => (
                    <option key={option.id} value={option.id}>
                      {index === 0
                        ? t('asr.modelDefaultOption', { model: option.id })
                        : option.id}
                    </option>
                  ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {draftModelOption?.blurb
                  ?? (draftModelGroups ? t('asr.modelHintRouted') : t('asr.modelHint'))}
              </p>
            </div>
          )}

          <div data-modal-autofocus>
            <label htmlFor="asr-api-key" className="mb-1 block text-sm text-muted-foreground">{keyLabel}</label>
            <PasswordInput
              id="asr-api-key"
              label={keyLabel}
              value={draft.apiKey}
              onChange={(v) => patchDraft({ apiKey: v })}
              onSubmit={() => void handleSaveDraft()}
              placeholder={t('asr.keyPlaceholder', { platform: platformInfo.label, keyLabel })}
              className={inputClass}
            />
            {/\s/.test(draft.apiKey) && (
              <FormatHint text={t('asr.hint.key')} />
            )}
            {draftKeyInherited && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('asr.keyReused')}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <button type="button" onClick={() => void shellOpen(platformInfo.consoleUrl)} className={linkClass}>
                {t('asr.openConsole', { platform: platformInfo.label })}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </div>

          {notice && <Feedback tone={notice.tone} message={notice.message} detail={notice.detail} />}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleTest(draft, true)}>{testingId === draft.id ? t('asrTest.testing') : t('asrTest.start')}</Button>
            <Button variant="outline" size="sm" onClick={closeEditor} disabled={saving}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => void handleSaveDraft()} disabled={busy || !draftDirty}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const pendingDelete = profiles.find((p) => p.id === pendingDeleteId) ?? null

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-[18rem]">
            <div className="flex items-center gap-2">
              <h2 id="asr-service-heading" className="text-lg font-semibold">{t('asr.title')}</h2>
              <Tooltip
                variant="light"
                content={t('asr.help')}
              >
                <Info aria-label={t('asr.helpAria')} className={helpIconClass} />
              </Tooltip>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('asr.desc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void handleTestAll()}
              disabled={busy || profiles.length === 0}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', batch && 'animate-spin')} aria-hidden />
              {batch ? t('asr.testingBatch', { done: batch.done, total: batch.total }) : t('asr.testAll')}
            </Button>
            <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleNew} disabled={busy}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('common.new')}
            </Button>
          </div>
        </div>

        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">{t('asr.loading')}</p>
        ) : profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
            {t('asr.empty')}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="asr-service-heading"
            className="grid gap-2.5 sm:grid-cols-3"
          >
            {profiles.map(renderCard)}
          </div>
        )}

        {notice && (
          <Feedback className="mt-3" tone={notice.tone} message={notice.message} detail={notice.detail} />
        )}
      </CardContent>

      {renderEditor()}

      {pendingDelete && (
        <Modal title={t('asr.deleteTitle')} onClose={() => setPendingDeleteId('')} showCloseButton panelClassName="w-[420px]">
          <div className="mt-3 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('asr.deleteBody', { name: asrCardTitle(pendingDelete, profiles.filter((p) => p.provider === pendingDelete.provider).length) })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingDeleteId('')}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => void handleDelete(pendingDelete.id)}>{t('common.delete')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  )
}
