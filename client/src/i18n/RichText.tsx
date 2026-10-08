import type { ReactNode } from 'react'

export function RichText({ text, strongClassName = 'font-semibold' }: {
  text: string
  strongClassName?: string
}) {
  const parts = text.split('**')
  return (
    <>
      {parts.map((part, index): ReactNode => (
        index % 2 === 1
          ? <span key={index} className={strongClassName}>{part}</span>
          : part
      ))}
    </>
  )
}
