import { describe, it, expect } from 'vitest'
import { reduceBackdropDismiss, type BackdropPointerEvent } from '../useBackdropDismiss'

function play(events: BackdropPointerEvent[]): boolean[] {
  let armed = false
  return events.map((event) => {
    const next = reduceBackdropDismiss(armed, event)
    armed = next.armed
    return next.dismiss
  })
}

const downOn = { type: 'mousedown', onBackdrop: true } as const
const downOff = { type: 'mousedown', onBackdrop: false } as const
const clickOn = { type: 'click', onBackdrop: true } as const
const clickOff = { type: 'click', onBackdrop: false } as const

describe('backdrop dismissal', () => {
  it('closes on a backdrop click', () => {
    expect(play([downOn, clickOn])).toEqual([false, true])
  })

  it('preserves drafts when a drag starts in the panel', () => {
    expect(play([downOff, clickOn])).toEqual([false, false])
  })

  it('does not close for panel interactions', () => {
    expect(play([downOff, clickOff])).toEqual([false, false])
  })

  it('does not reuse a backdrop press for a panel click', () => {
    expect(play([downOn, clickOff, clickOff])).toEqual([false, false, false])
  })

  it('requires another press after dismissal', () => {
    expect(play([downOn, clickOn, clickOn])).toEqual([false, true, false])
  })

  it('waits for click instead of dismissing on mousedown', () => {
    expect(play([downOn, downOn])).toEqual([false, false])
  })
})
