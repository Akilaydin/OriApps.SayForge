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

describe('点背板关闭弹窗的判据', () => {
  it('在背板空白处点一下 → 关闭', () => {
    expect(play([downOn, clickOn])).toEqual([false, true])
  })

  it('面板内按下、拖到面板外松开 → 不关（草稿不能就这么丢了）', () => {
    expect(play([downOff, clickOn])).toEqual([false, false])
  })

  it('整个交互都在面板内 → 不关', () => {
    expect(play([downOff, clickOff])).toEqual([false, false])
  })

  it('背板按下但没等到 click，之后面板内的 click 不能关', () => {
    expect(play([downOn, clickOff, clickOff])).toEqual([false, false, false])
  })

  it('关过一次之后要重新按下才能再关', () => {
    expect(play([downOn, clickOn, clickOn])).toEqual([false, true, false])
  })

  it('mousedown 自己永远不关闭 —— 要等松开，否则拖选背景文字也会关', () => {
    expect(play([downOn, downOn])).toEqual([false, false])
  })
})
