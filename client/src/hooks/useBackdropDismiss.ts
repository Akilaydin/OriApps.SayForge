//
//
//

import { useRef, type MouseEvent } from 'react'

export type BackdropPointerEvent =
  | { type: 'mousedown'; onBackdrop: boolean }
  | { type: 'click'; onBackdrop: boolean }

export function reduceBackdropDismiss(
  armed: boolean,
  event: BackdropPointerEvent,
): { armed: boolean; dismiss: boolean } {
  if (event.type === 'mousedown') {
    return { armed: event.onBackdrop, dismiss: false }
  }
  if (!armed) return { armed, dismiss: false }
  return { armed: false, dismiss: event.onBackdrop }
}

export function useBackdropDismiss(onDismiss: () => void) {
  const armedRef = useRef(false)

  const step = (event: BackdropPointerEvent) => {
    const next = reduceBackdropDismiss(armedRef.current, event)
    armedRef.current = next.armed
    if (next.dismiss) onDismiss()
  }

  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      step({ type: 'mousedown', onBackdrop: event.target === event.currentTarget })
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      step({ type: 'click', onBackdrop: event.target === event.currentTarget })
    },
  }
}
