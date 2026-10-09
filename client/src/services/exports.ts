import * as bridge from './bridge'
import { save } from '@tauri-apps/plugin-dialog'
import { BUILTIN_SET_ACTIVE_KEY, BUILTIN_SET_WORDS_KEY, CUSTOM_THEME_ACTIVE_KEY, CUSTOM_THEMES_KEY, LEGACY_MANUAL_WORDS_KEY } from './hotwords/model'
import { getSetting, listHistory, type HistoryListQuery } from './store'

function slugTimestamp() { return new Date().toISOString().replace(/[:.]/g, '-') }

async function saveTextFile(defaultPath: string, content: string, filters: Array<{ name: string; extensions: string[] }>) {
  const path = await save({ defaultPath, filters })
  if (!path) return { canceled: true, filePath: null }
  const filePath = await bridge.saveTextExport({ defaultPath: path, content, filters })
  return { canceled: !filePath, filePath }
}

export async function exportHistory(query: HistoryListQuery = {}) {
  const records = await listHistory({ keyword: query.keyword })
  const text = records.map((record) => new Date(record.timestamp).toISOString() + '\n' + (record.llmText || record.asrText)).join('\n\n')
  return saveTextFile('sayforge-history-' + slugTimestamp() + '.txt', text, [{ name: 'Text', extensions: ['txt'] }])
}

async function buildHotwordsPayload() {
  const [
    activeWords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    manualHotwords,
    builtinHotwordSets,
    hotwordLearning,
  ] = await Promise.all([
    getSetting<string[]>(LEGACY_MANUAL_WORDS_KEY, []).catch(() => [] as string[]),
    getSetting<Record<string, string[]>>(BUILTIN_SET_WORDS_KEY, {}),
    getSetting<Record<string, boolean>>(BUILTIN_SET_ACTIVE_KEY, {}),
    getSetting(CUSTOM_THEMES_KEY, [] as unknown[]),
    getSetting<Record<string, boolean>>(CUSTOM_THEME_ACTIVE_KEY, {}),
    getSetting<string[]>(LEGACY_MANUAL_WORDS_KEY, []),
    getSetting<Record<string, unknown>>('builtinHotwordSets', {}),
    getSetting('hotwordLearning', null),
  ])

  return {
    exportedAt: new Date().toISOString(),
    activeWords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    manualHotwords,
    builtinHotwordSets,
    hotwordLearning,
  }
}

export async function exportHotwords() {
  const payload = await buildHotwordsPayload()
  return saveTextFile(
    `sayforge-hotwords-${slugTimestamp()}.json`,
    JSON.stringify(payload, null, 2),
    [{ name: 'JSON Files', extensions: ['json'] }],
  )
}
