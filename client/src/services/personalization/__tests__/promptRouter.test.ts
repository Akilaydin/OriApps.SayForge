import { describe, it, expect } from 'vitest'
import { matchesAppPromptRule } from '../promptRouter'
import { BUILTIN_APP_RULES } from '../defaults'
import type { AppPromptRule } from '../types'
import type { ActiveAppContext } from '@/types/appContext'

function ruleById(id: string): AppPromptRule {
  const rule = BUILTIN_APP_RULES.find((r) => r.id === id)
  if (!rule) throw new Error(`Unknown built-in application rule: ${id}`)
  return rule
}

describe('matchesAppPromptRule', () => {
  it('matches a configured process name', () => {
    const ctx: ActiveAppContext = { processName: 'outlook.exe', windowTitle: 'Inbox - Outlook' }
    expect(matchesAppPromptRule(ruleById('outlook'), ctx)).toBe(true)
  })

  it('does not let window-title keywords override a known executable', () => {
    const ctx: ActiveAppContext = { processName: 'outlook.exe', windowTitle: 'Teams meeting notes - Outlook' }
    expect(matchesAppPromptRule(ruleById('teams'), ctx)).toBe(false)
    expect(matchesAppPromptRule(ruleById('outlook'), ctx)).toBe(true)
  })

  it('does not misclassify VS Code documents based on a filename', () => {
    const ctx: ActiveAppContext = { processName: 'code.exe', windowTitle: 'teams_faq.md - proj - Visual Studio Code' }
    expect(matchesAppPromptRule(ruleById('teams'), ctx)).toBe(false)
    expect(matchesAppPromptRule(ruleById('vscode'), ctx)).toBe(true)
  })

  it('does not use title matches when the detected process differs', () => {
    const ctx: ActiveAppContext = { processName: 'chrome.exe', windowTitle: 'Outlook - Google Chrome' }
    expect(matchesAppPromptRule(ruleById('outlook'), ctx)).toBe(false)
  })

  it('falls back to title matching for rules without process names', () => {
    const webRule: AppPromptRule = {
      ...ruleById('outlook'),
      id: 'outlook-web',
      matcher: { processNames: [], windowTitleIncludes: ['outlook'] },
    }
    const ctx: ActiveAppContext = { processName: 'msedge.exe', windowTitle: 'Inbox - Outlook - Microsoft Edge' }
    expect(matchesAppPromptRule(webRule, ctx)).toBe(true)
  })

  it('falls back to title matching when process name detection fails', () => {
    const rule: AppPromptRule = {
      ...ruleById('outlook'),
      matcher: { processNames: ['outlook.exe'], windowTitleIncludes: ['outlook'] },
    }
    const ctx: ActiveAppContext = { windowTitle: 'Inbox - Outlook' }
    expect(matchesAppPromptRule(rule, ctx)).toBe(true)
  })

  it('never matches a built-in rule by title alone', () => {
    for (const rule of BUILTIN_APP_RULES) {
      expect(rule.matcher.processNames.length).toBeGreaterThan(0)
      expect(rule.matcher.windowTitleIncludes ?? []).toHaveLength(0)
    }
  })

  it('falls back to parsing the exePath', () => {
    const ctx: ActiveAppContext = { exePath: 'C:\\Program Files\\Notepad\\notepad.exe' }
    expect(matchesAppPromptRule(ruleById('notepad'), ctx)).toBe(true)
  })

  it('does not match with no application context', () => {
    expect(matchesAppPromptRule(ruleById('teams'), null)).toBe(false)
  })
})
