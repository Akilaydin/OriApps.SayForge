import type { ActiveAppContext } from '@/types/appContext'
import { BUILTIN_PRESETS } from '@/services/store'
import type { AppPromptRule, PromptResolution, PromptRoutingInput } from './types'
import { buildDynamicIdentityPrompt, summarizeDomainScenes } from './userStats'

function normalizeText(value?: string) {
  return String(value || '').trim().toLowerCase()
}

function normalizeProcessName(context: ActiveAppContext | null) {
  const processName = normalizeText(context?.processName)
  if (processName) return processName

  const exePath = String(context?.exePath || '')
  const segments = exePath.split(/[\\/]/)
  return normalizeText(segments[segments.length - 1])
}

function includesAny(value: string, patterns?: string[]) {
  if (!value || !patterns?.length) return false
  return patterns.some((pattern) => value.includes(normalizeText(pattern)))
}

export function matchesAppPromptRule(rule: AppPromptRule, context: ActiveAppContext | null) {
  if (!context) return false

  const processName = normalizeProcessName(context)

  if (rule.matcher.processNames.length > 0 && processName) {
    return rule.matcher.processNames.some((candidate) => processName === normalizeText(candidate))
  }

  const windowTitle = normalizeText(context.windowTitle)
  const windowClass = normalizeText(context.windowClass)
  const automationId = normalizeText(context.automationId)
  if (includesAny(windowTitle, rule.matcher.windowTitleIncludes)) return true
  if (includesAny(windowClass, rule.matcher.windowClasses)) return true
  if (includesAny(automationId, rule.matcher.automationIds)) return true
  return false
}

function pickPreset(presetId: string | undefined, presets: PromptRoutingInput['presets'], activePresetId: string) {
  const fallback = presets.find((preset) => preset.id === activePresetId)
    || BUILTIN_PRESETS.find((preset) => preset.id === activePresetId)
    || presets[0]
    || BUILTIN_PRESETS[0]

  if (!presetId) return fallback
  return presets.find((preset) => preset.id === presetId)
    || BUILTIN_PRESETS.find((preset) => preset.id === presetId)
    || fallback
}

function summarizeResolution(parts: string[]) {
  return parts.filter(Boolean).join(' | ')
}

export function buildHotwordInjectionPart(hotwords: string[] | undefined): string | null {
  if (!hotwords || hotwords.length === 0) return null
  const terms = Array.from(new Set(hotwords.map((w) => w.trim()).filter(Boolean)))
  if (terms.length === 0) return null
  return `User's technical vocabulary: Prefer the following spellings and capitalization when speech recognition is ambiguous, and preserve them exactly:\n${terms.join(', ')}`
}

export function resolvePromptRouting(input: PromptRoutingInput): PromptResolution {
  const matchedRule = input.appRules
    .find((rule) => rule.enabled && matchesAppPromptRule(rule, input.appContext))

  const preset = pickPreset(matchedRule?.presetId, input.presets, input.activePresetId)
  const systemPromptParts = [preset.systemPrompt.trim()]
  const dominantScene = summarizeDomainScenes(input.userStats, 1)[0]

  if (matchedRule?.promptAppend) {
    systemPromptParts.push(`Application-specific instructions:\n${matchedRule.promptAppend.trim()}`)
  }

  const dynamicIdentityPrompt = buildDynamicIdentityPrompt(input.userStats)
  if (dynamicIdentityPrompt) {
    systemPromptParts.push(`User writing preferences:\n${dynamicIdentityPrompt}`)
  }

  let hotwordInjected = false
  if (input.injectHotwords) {
    const part = buildHotwordInjectionPart(input.hotwords)
    if (part) {
      systemPromptParts.push(part)
      hotwordInjected = true
    }
  }

  const summaryParts = [
    `Base preset id: ${preset.id}`,
    matchedRule ? `App rule id: ${matchedRule.id}` : 'App rule: no match',
    dynamicIdentityPrompt && dominantScene ? `User profile: ${dominantScene.label}` : '',
    hotwordInjected ? 'Hotwords injected: yes' : '',
  ]

  return {
    appId: matchedRule?.appId,
    appName: matchedRule?.name,
    preset,
    matchedRule,
    systemPrompt: systemPromptParts.join('\n\n'),
    summary: summarizeResolution(summaryParts),
  }
}
