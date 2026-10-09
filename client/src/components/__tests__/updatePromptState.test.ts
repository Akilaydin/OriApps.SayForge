import { describe, expect, it } from 'vitest'
import { showUpdatePrompt, updateErrorMessageKey } from '../updatePromptState'

describe('UpdatePrompt visibility', () => {
  it('shows an error from a failed explicit Retry even outside About', () => {
    expect(showUpdatePrompt({ phase: 'error', errorStage: 'check' }, true, true)).toBe(true)
    expect(updateErrorMessageKey('check')).toBe('updater.checkFailed')
  })

  it('distinguishes an installer failure from a GitHub check failure', () => {
    expect(showUpdatePrompt({ phase: 'error', errorStage: 'install' }, true, true)).toBe(true)
    expect(updateErrorMessageKey('install')).toBe('updater.installFailed')
  })

  it('keeps silent startup failures and tray startup invisible', () => {
    expect(showUpdatePrompt({ phase: 'idle' }, true, true)).toBe(false)
    expect(showUpdatePrompt({ phase: 'error', errorStage: 'check' }, false, true)).toBe(false)
  })

  it('does not interrupt recording to offer an update', () => {
    expect(showUpdatePrompt({ phase: 'available', version: '0.2.6' }, true, false)).toBe(false)
    expect(showUpdatePrompt({ phase: 'available', version: '0.2.6' }, true, true)).toBe(true)
  })
})
