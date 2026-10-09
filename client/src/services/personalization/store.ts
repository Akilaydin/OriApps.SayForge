import { getSetting, setSetting } from '@/services/store'
import { BUILTIN_APP_RULES, createDefaultUserStats } from './defaults'
import type {
  AppPromptMatcher,
  AppPromptRule,
  UserStats,
} from './types'

const APP_PROMPT_RULES_KEY = 'appPromptRules'
const USER_STATS_KEY = 'userStats'

function normalizeMatcher(value: unknown): AppPromptMatcher {
  const matcher = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const normalizeList = (input: unknown) => Array.isArray(input)
    ? input.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  return {
    processNames: normalizeList(matcher.processNames),
    windowTitleIncludes: normalizeList(matcher.windowTitleIncludes),
    windowClasses: normalizeList(matcher.windowClasses),
    automationIds: normalizeList(matcher.automationIds),
  }
}

function normalizeAppPromptRule(raw: unknown, fallback?: AppPromptRule): AppPromptRule | null {
  if (!raw || typeof raw !== 'object') return fallback ? { ...fallback } : null
  const value = raw as Record<string, unknown>
  const id = String(value.id || fallback?.id || '').trim()
  const appId = String(value.appId || fallback?.appId || '').trim()
  const name = String(value.name || fallback?.name || '').trim()
  if (!id || !appId || !name) return fallback ? { ...fallback } : null

  return {
    id,
    appId,
    name,
    builtin: value.builtin === true || fallback?.builtin === true,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback?.enabled ?? false,
    presetId: String(value.presetId ?? fallback?.presetId ?? '').trim() || undefined,
    promptAppend: String(value.promptAppend ?? fallback?.promptAppend ?? '').trim(),
    matcher: normalizeMatcher(value.matcher ?? fallback?.matcher ?? {}),
  }
}

function normalizeUserStats(raw: unknown): UserStats {
  const defaults = createDefaultUserStats()
  if (!raw || typeof raw !== 'object') return defaults

  const value = raw as Record<string, unknown>

  const domainWordsRaw = value.domainWords && typeof value.domainWords === 'object'
    ? value.domainWords as Record<string, unknown>
    : {}
  const domainWords: Record<string, number> = {}
  for (const [appId, wordCount] of Object.entries(domainWordsRaw)) {
    const normalizedAppId = String(appId || '').trim()
    const count = Number(wordCount ?? 0)
    if (!normalizedAppId || !Number.isFinite(count) || count <= 0) continue
    domainWords[normalizedAppId] = Math.round(count)
  }

  const appUsageCountRaw = value.appUsageCount && typeof value.appUsageCount === 'object'
    ? value.appUsageCount as Record<string, unknown>
    : {}
  const appUsageCount: Record<string, number> = {}
  for (const [appId, count] of Object.entries(appUsageCountRaw)) {
    const normalizedAppId = String(appId || '').trim()
    const usageCount = Number(count ?? 0)
    if (!normalizedAppId || !Number.isFinite(usageCount) || usageCount <= 0) continue
    appUsageCount[normalizedAppId] = Math.round(usageCount)
  }

  const totalWords = Number(value.totalWords ?? defaults.totalWords)
  const totalSessions = Number(value.totalSessions ?? defaults.totalSessions)
  const firstUsedAt = Number(value.firstUsedAt ?? 0)
  const lastUsedAt = Number(value.lastUsedAt ?? 0)

  return {
    totalWords: Number.isFinite(totalWords) ? Math.max(0, Math.round(totalWords)) : defaults.totalWords,
    totalSessions: Number.isFinite(totalSessions) ? Math.max(0, Math.round(totalSessions)) : defaults.totalSessions,
    domainWords,
    appUsageCount,
    firstUsedAt: firstUsedAt > 0 ? Math.round(firstUsedAt) : undefined,
    lastUsedAt: lastUsedAt > 0 ? Math.round(lastUsedAt) : undefined,
  }
}

export async function getAppPromptRules(): Promise<AppPromptRule[]> {
  const saved = await getSetting<unknown>(APP_PROMPT_RULES_KEY, [])
  const builtinById = new Map(BUILTIN_APP_RULES.map((rule) => [rule.id, rule]))
  const ordered: AppPromptRule[] = []
  const seen = new Set<string>()

  if (Array.isArray(saved)) {
    for (const item of saved) {
      const id = String((item as { id?: unknown } | null)?.id ?? '').trim()
      const skeleton = builtinById.get(id)
      const normalized = normalizeAppPromptRule(item, skeleton)
      if (!normalized || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      ordered.push(skeleton ? normalized : { ...normalized, builtin: false })
    }
  }

  const missing = BUILTIN_APP_RULES
    .filter((rule) => !seen.has(rule.id))
    .map((rule) => ({ ...rule, matcher: { ...rule.matcher } }))

  return [...ordered, ...missing]
}

export async function saveAppPromptRules(rules: AppPromptRule[]): Promise<void> {
  await setSetting(APP_PROMPT_RULES_KEY, rules)
}

export async function getUserStats(): Promise<UserStats> {
  return normalizeUserStats(await getSetting<unknown>(USER_STATS_KEY, createDefaultUserStats()))
}

export async function saveUserStats(stats: UserStats): Promise<void> {
  await setSetting(USER_STATS_KEY, stats)
}

export async function recordSessionStats(appId: string, wordCount: number): Promise<UserStats> {
  const normalizedAppId = String(appId || '').trim() || 'unknown'
  const safeWordCount = Math.max(0, Math.round(wordCount))
  const now = Date.now()

  const nextStats = await getUserStats()
  nextStats.totalWords += safeWordCount
  nextStats.totalSessions += 1
  nextStats.lastUsedAt = now

  if (!nextStats.firstUsedAt) {
    nextStats.firstUsedAt = now
  }

  if (safeWordCount > 0) {
    nextStats.domainWords = {
      ...nextStats.domainWords,
      [normalizedAppId]: (nextStats.domainWords[normalizedAppId] || 0) + safeWordCount,
    }
  }

  nextStats.appUsageCount = {
    ...nextStats.appUsageCount,
    [normalizedAppId]: (nextStats.appUsageCount[normalizedAppId] || 0) + 1,
  }

  await saveUserStats(nextStats)
  return nextStats
}
