import { describe, expect, it } from 'vitest'
import { diagnoseFailure, failureMessage, insertionFailureMessage } from '../errorMessages'

describe('actionable diagnostics without private exception text', () => {
  it.each([
    ['HTTP 503: SYNTHETIC_PRIVATE_BODY', 'http', undefined],
    ['Request timed out HTTP 504', 'timeout', undefined],
    ['DNS lookup failed for synthetic.invalid', 'network', 'dns'],
    ['TLS certificate expired', 'network', 'tls'],
    ['Permission denied', 'local', 'permission'],
  ])('classifies %s', (error, kind, reason) => {
    const diagnostic = diagnoseFailure(error)
    expect(diagnostic.kind).toBe(kind)
    expect(diagnostic.reason).toBe(reason)
    expect(JSON.stringify(diagnostic)).not.toContain('SYNTHETIC_PRIVATE_BODY')
  })

  it('retains a bounded nested cause and native code without keeping response content', () => {
    const error = Object.assign(new Error('error sending request'), {
      cause: new Error('TLS certificate expired HRESULT=0x80090328 SYNTHETIC_SECRET'),
    })
    expect(diagnoseFailure(error).cause).toMatchObject({ reason: 'tls', nativeCode: '0x80090328' })
    expect(JSON.stringify(diagnoseFailure(error))).not.toContain('SYNTHETIC_SECRET')
  })

  it('keeps clipboard/focus failures distinct from an application refusing text and warns about unconfirmed delivery', () => {
    expect(insertionFailureMessage('clipboard_unavailable')).toMatch(/clipboard/i)
    expect(insertionFailureMessage('clipboard_unavailable')).not.toMatch(/app won't accept/i)
    expect(insertionFailureMessage('focus_not_confirmed')).toMatch(/focus/i)
    expect(insertionFailureMessage('paste_unconfirmed')).toMatch(/duplicate|before copying/i)
    const error = 'sayforge_error:clipboard_unsupported_format:unsupported clipboard format 9'
    const message = failureMessage(error, 'Copy failed.')
    expect(message).toMatch(/cannot be safely preserved/i)
    expect(message).not.toMatch(/format 9|another app/i)
  })
})
