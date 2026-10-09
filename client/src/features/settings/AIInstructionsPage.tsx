import { useEffect, useState } from 'react'
import { BUILTIN_APP_RULES } from '@/services/personalization/defaults'
import {
  getAppPromptRules,
  saveAppPromptRules,
} from '@/services/personalization/store'
import { moveItem } from '@/components/ui/sortable'
import type { AppPromptRule } from '@/services/personalization/types'
import {
  refreshPreset,
  refreshRecorderSettings,
  setActivePresetCache,
  setPromptPresetsCache,
} from '@/services/recorder'
import * as bridge from '@/services/bridge'
import { useActivePreset } from '@/hooks/useActivePreset'
import { refreshActivePreset, setActivePresetKnown } from '@/stores/activePreset'
import {
  deletePromptPreset,
  getBuiltinPromptLanguage,
  getPromptPresets,
  moveCustomPromptPreset,
  getPresetShortcuts,
  getSetting,
  savePromptPreset,
  setActivePresetId,
  setPresetShortcuts,
  type BuiltinPromptLanguage,
  type PromptPreset,
} from '@/services/store'
import AIProofreadToggle from './AIProofreadToggle'
import HotwordPromptInjectToggle from './HotwordPromptInjectToggle'
import AppPromptRulesSection from './AppPromptRulesSection'
import PromptPresetSection from './PromptPresetSection'
import { useT } from '@/i18n/useT'

export default function AIInstructionsPage() {
  const t = useT()
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [promptLanguage, setPromptLanguage] = useState<BuiltinPromptLanguage>('en')
  const activePreset = useActivePreset()
  const activePresetId = activePreset.id
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null)
  const [appPromptRules, setAppPromptRules] = useState<AppPromptRule[]>([])
  const [editingShortcut, setEditingShortcut] = useState('')
  const [presetShortcuts, setPresetShortcutsState] = useState<Record<string, string>>({})

  useEffect(() => {
    void getBuiltinPromptLanguage().then(async (language) => {
      const loadedPresets = await getPromptPresets(language)
      setPromptLanguage(language)
      setPresets(loadedPresets)
    })
    getAppPromptRules().then(setAppPromptRules)
    getPresetShortcuts().then(setPresetShortcutsState)
    void refreshActivePreset()
  }, [])

  const validatePresetShortcut = async (value: string): Promise<string | null> => {
    if (!value) return null
    const ptt = await getSetting('shortcutPTT', 'AltRight') as string
    const handsFree = await getSetting('shortcutHandsFree', 'Alt+L') as string
    if (value === ptt) return t('aiInstructions.conflictPtt')
    if (value === handsFree) return t('aiInstructions.conflictHandsFree')
    return null
  }

  const handleSetPresetShortcut = async (presetId: string, accel: string) => {
    const next: Record<string, string> = { ...presetShortcuts }
    if (!accel) {
      delete next[presetId]
    } else {
      for (const key of Object.keys(next)) {
        if (next[key] === accel) delete next[key]
      }
      next[presetId] = accel
    }
    setPresetShortcutsState(next)
    await setPresetShortcuts(next)
    bridge.notifyShortcutsChanged()
  }

  const handleSelectPreset = (id: string) => {
    const target = presets.find((p) => p.id === id)
    setActivePresetKnown(id, target?.name || '')
    setActivePresetCache(id)
    void setActivePresetId(id)
  }

  const handleSavePreset = async (preset: PromptPreset) => {
    await savePromptPreset(preset)
    if ((presetShortcuts[preset.id] || '') !== editingShortcut) {
      await handleSetPresetShortcut(preset.id, editingShortcut)
    }
    const nextPresets = await getPromptPresets()
    setPresets(nextPresets)
    setPromptPresetsCache(nextPresets)
    setEditingPreset(null)
    setEditingShortcut('')
    await refreshActivePreset()
  }

  const handleDeletePreset = async (id: string) => {
    await deletePromptPreset(id)
    const nextPresets = await getPromptPresets()
    setPresets(nextPresets)
    setPromptPresetsCache(nextPresets)
    if (presetShortcuts[id]) {
      const next = { ...presetShortcuts }
      delete next[id]
      setPresetShortcutsState(next)
      await setPresetShortcuts(next)
      bridge.notifyShortcutsChanged()
    }
    if (id === activePresetId) {
      await setActivePresetId('intent')
      await refreshPreset()
      await refreshActivePreset()
    }
  }

  const handleNewPreset = () => {
    setEditingPreset({
      id: Date.now().toString(36),
      name: '',
      systemPrompt: '',
    })
    setEditingShortcut('')
  }

  const handleStartEditing = (preset: PromptPreset) => {
    setEditingPreset(preset)
    setEditingShortcut(presetShortcuts[preset.id] || '')
  }

  const handleCancelEditing = () => {
    setEditingPreset(null)
    setEditingShortcut('')
  }

  const handleMovePreset = async (from: number, to: number) => {
    await moveCustomPromptPreset(from, to)
    const nextPresets = await getPromptPresets()
    setPresets(nextPresets)
    setPromptPresetsCache(nextPresets)
  }

  const applyAppRules = async (nextRules: AppPromptRule[]) => {
    setAppPromptRules(nextRules)
    await saveAppPromptRules(nextRules)
    await refreshRecorderSettings()
  }

  const handleSaveAppRule = async (rule: AppPromptRule) => {
    await applyAppRules(appPromptRules.map((item) => (item.id === rule.id ? rule : item)))
  }

  const handleToggleAppRule = async (ruleId: string, enabled: boolean) => {
    const target = appPromptRules.find((rule) => rule.id === ruleId)
    if (!target) return
    const updated = { ...target, enabled }
    await applyAppRules(enabled
      ? [updated, ...appPromptRules.filter((rule) => rule.id !== ruleId)]
      : appPromptRules.map((rule) => (rule.id === ruleId ? updated : rule)))
  }

  const handleMoveAppRule = async (from: number, to: number) => {
    const nextRules = moveItem(appPromptRules, from, to)
    if (nextRules === appPromptRules) return
    await applyAppRules(nextRules)
  }

  const handleCreateAppRule = async (draft: {
    name: string
    processNames: string[]
    presetId?: string
    promptAppend: string
  }) => {
    const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const rule: AppPromptRule = {
      id,
      appId: id,
      name: draft.name,
      builtin: false,
      enabled: true,
      presetId: draft.presetId,
      promptAppend: draft.promptAppend,
      matcher: { processNames: draft.processNames, windowTitleIncludes: [], windowClasses: [], automationIds: [] },
    }
    await applyAppRules([rule, ...appPromptRules])
  }

  const handleDeleteAppRule = async (ruleId: string) => {
    await applyAppRules(appPromptRules.filter((rule) => rule.id !== ruleId))
  }

  const handleResetAppRule = async (ruleId: string) => {
    const fallback = BUILTIN_APP_RULES.find((rule) => rule.id === ruleId)
    if (!fallback) return
    await applyAppRules(appPromptRules.map((rule) => (
      rule.id === ruleId ? { ...fallback, matcher: { ...fallback.matcher } } : rule
    )))
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold">{t('nav.aiInstructions')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {t('aiInstructions.subtitle')}
      </p>

      <div className="space-y-6">
        <AIProofreadToggle />
        <HotwordPromptInjectToggle />

        <PromptPresetSection
          presets={presets}
          activePresetId={activePresetId}
          editingPreset={editingPreset}
          presetShortcuts={presetShortcuts}
          editingShortcut={editingShortcut}
          promptLanguage={promptLanguage}
          validateShortcut={validatePresetShortcut}
          onSelectPreset={handleSelectPreset}
          onStartNewPreset={handleNewPreset}
          onStartEditing={handleStartEditing}
          onEditingPresetChange={setEditingPreset}
          onEditingShortcutChange={setEditingShortcut}
          onCancelEditing={handleCancelEditing}
          onSavePreset={handleSavePreset}
          onDeletePreset={handleDeletePreset}
          onMovePreset={handleMovePreset}
        />

        <AppPromptRulesSection
          presets={presets}
          rules={appPromptRules}
          onSaveRule={handleSaveAppRule}
          onToggleRule={handleToggleAppRule}
          onMoveRule={handleMoveAppRule}
          onResetRule={handleResetAppRule}
          onCreateRule={handleCreateAppRule}
          onDeleteRule={handleDeleteAppRule}
        />
      </div>
    </div>
  )
}
