//
//
//

import { useRef, useState, type ComponentPropsWithoutRef, type DragEvent, type KeyboardEvent } from 'react'
import { GripVertical } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'

export interface SortableOptions {
  onMove: (from: number, to: number) => void
}

export function useSortable({ onMove }: SortableOptions) {
  const t = useT()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const rowRefs = useRef<Array<HTMLElement | null>>([])

  const registerRow = (index: number) => (element: HTMLElement | null) => {
    rowRefs.current[index] = element
  }

  const handleProps = (index: number, label: string) => ({
    draggable: true,
    'aria-label': t('ui.sortableAria', { label }),
    onDragStart: (event: DragEvent) => {
      setDragIndex(index)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(index))
      const row = rowRefs.current[index]
      if (row) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2)
    },
    onDragEnd: () => {
      setDragIndex(null)
      setOverIndex(null)
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        onMove(index, index - 1)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        onMove(index, index + 1)
      }
    },
  })

  const rowProps = (index: number) => ({
    ref: registerRow(index),
    onDragOver: (event: DragEvent) => {
      if (dragIndex === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setOverIndex(index)
    },
    onDragLeave: () => {
      setOverIndex((current) => (current === index ? null : current))
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      if (dragIndex !== null && dragIndex !== index) onMove(dragIndex, index)
      setDragIndex(null)
      setOverIndex(null)
    },
  })

  const rowClassName = (index: number) => cn(
    dragIndex === index && 'opacity-40',
    overIndex === index && dragIndex !== null && dragIndex !== index && (
      index > dragIndex ? 'border-b-2 border-b-primary' : 'border-t-2 border-t-primary'
    ),
  )

  return { handleProps, rowProps, rowClassName, dragIndex }
}

export function DragHandle({
  className,
  ...rest
}: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'shrink-0 cursor-grab select-none rounded p-1 text-muted-foreground/0 transition-colors',
        'group-hover:text-muted-foreground/60 hover:bg-accent hover:text-foreground',
        'focus-visible:text-muted-foreground active:cursor-grabbing',
        className,
      )}
      {...rest}
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden />
    </div>
  )
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
