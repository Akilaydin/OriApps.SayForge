import { useState } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { HistoryRecord } from '@/services/store'
import { getLocale } from '@/i18n'
import { useT } from '@/i18n/useT'
import { historyFailureReasonDisplay } from '@/i18n/displayNames'

export default function HistoryRecordList({ records, onDelete, emptyText }: {
  records: HistoryRecord[]
  onDelete: (id: string) => Promise<void> | void
  emptyText: string
}) {
  const t = useT()
  const [error, setError] = useState('')
  const copy = async (text: string) => {
    try { await writeText(text); setError('') }
    catch (cause) { setError(String(cause)) }
  }
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!records.length && <p className="py-12 text-center text-muted-foreground">{emptyText}</p>}
      {records.map((record) => {
        const text = record.llmText || record.asrText
        return (
          <Card key={record.id}>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <time dateTime={new Date(record.timestamp).toISOString()} className="text-xs text-muted-foreground">
                  {new Date(record.timestamp).toLocaleString(getLocale())}
                </time>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" disabled={!text} onClick={() => void copy(text)} aria-label={t('record.copy')}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => void onDelete(record.id)} aria-label={t('record.delete')}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">{text || historyFailureReasonDisplay(record)}</p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
