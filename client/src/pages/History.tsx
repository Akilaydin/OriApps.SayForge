import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import HistoryRecordList from '@/components/history/HistoryRecordList'
import * as bridge from '@/services/bridge'
import { countHistory, deleteHistory, listHistory, type HistoryRecord } from '@/services/store'
import { exportHistory } from '@/services/exports'
import { useT } from '@/i18n/useT'
import { runAction } from '@/services/actionFeedback'
import { useActionPending } from '@/components/ActionFeedback'

const PAGE_SIZE = 100

export default function History() {
  const t = useT()
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [keyword, setKeyword] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const request = useRef(0)
  const exportPending = useActionPending('history-export')
  const deletePending = useActionPending('history-delete')

  const reload = useCallback(async () => {
    const id = ++request.current
    try {
      const [items, count] = await Promise.all([
        listHistory({ keyword: search, limit }),
        countHistory({ keyword: search }),
      ])
      if (id !== request.current) return
      setRecords(items)
      setTotal(count)
      setStatus('')
    } catch (error) {
      if (id === request.current) setStatus(String(error))
    }
  }, [search, limit])

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(keyword); setLimit(PAGE_SIZE) }, 300)
    return () => clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    void reload()
    const unlisten = bridge.listen('history-updated', () => void reload())
    return () => { request.current++; void unlisten.then((fn) => fn()) }
  }, [reload])

  const remove = async (id: string) => {
    await runAction('history-delete', async () => {
      await deleteHistory(id)
      await reload()
    }, { confirmation: t('feedback.confirmDeleteRecord'), success: t('feedback.deleted'), error: t('feedback.deleteFailed') })
  }

  const download = async () => {
    await runAction('history-export', async () => {
      const result = await exportHistory({ keyword: search })
      setStatus(result.filePath ? t('history.savedTo', { path: result.filePath }) : '')
      return !result.canceled
    }, { success: t('feedback.exported'), canceled: t('feedback.canceled'), error: t('feedback.exportFailed') })
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('history.title')}</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('history.searchPlaceholder')}
              aria-label={t('history.searchPlaceholder')}
              className="rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm" />
          </div>
          <Button variant="outline" size="sm" disabled={exportPending} onClick={() => void download()} aria-label={t('history.export')}>
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {status && <p role="status" className="mb-3 break-all text-xs text-muted-foreground">{status}</p>}
      <HistoryRecordList records={records} onDelete={remove} deletePending={deletePending}
        emptyText={search.trim() ? t('history.emptyNoMatch') : t('history.empty')} />
      {total > records.length && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>{t('history.loadMore')}</Button>
        </div>
      )}
    </div>
  )
}
