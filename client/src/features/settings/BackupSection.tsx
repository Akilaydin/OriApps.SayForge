import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import {
  exportConfigFile, inspectConfigImport, pickImportFile, runImport, restartApp,
  type ConfigImportPreview,
} from '@/services/backup'
import { useT } from '@/i18n/useT'

type Confirmation = { kind: 'config' | 'full'; path: string; preview?: ConfigImportPreview }

export default function BackupSection() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)

  const exportSettings = async () => {
    setBusy(true)
    try {
      const result = await exportConfigFile({ mode: 'full' })
      setStatus(t('backup.savedTo', { path: result.filePath || '' }))
    } catch (error) { setStatus(String(error)) }
    finally { setBusy(false) }
  }

  const chooseImport = async (kind: 'config' | 'full') => {
    setBusy(true)
    try {
      const path = await pickImportFile(kind)
      if (!path) return
      const preview = kind === 'config' ? await inspectConfigImport(path) : undefined
      setConfirmation({ kind, path, preview })
    } catch (error) { setStatus(String(error)) }
    finally { setBusy(false) }
  }

  const confirmImport = async () => {
    if (!confirmation) return
    setBusy(true)
    try {
      await runImport(confirmation.kind, confirmation.path, confirmation.preview?.importToken)
      setConfirmation(null)
      setRestartRequired(true)
      setStatus(t('backup.importComplete'))
    } catch (error) { setStatus(String(error)) }
    finally { setBusy(false) }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="text-lg font-semibold">{t('backup.configTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('backup.configDesc')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void exportSettings()}>
            <Download className="mr-2 h-4 w-4" />{t('backup.export')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void chooseImport('config')}>
            <Upload className="mr-2 h-4 w-4" />{t('backup.import')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void chooseImport('full')}>{t('backup.restoreLegacy')}</Button>
        </div>
        {status && <p role="status" className="break-all text-sm text-muted-foreground">{status}</p>}
        {restartRequired && <Button disabled={busy} onClick={() => void restartApp().catch((error) => setStatus(String(error)))}>{t('backup.restart')}</Button>}
      </CardContent>
      {confirmation && (
        <Modal title={t('configTransfer.importTitle')} locked={busy} onClose={() => setConfirmation(null)} panelClassName="w-full max-w-lg">
          <p className="my-4 text-sm">{confirmation.kind === 'full'
            ? t('configTransfer.fullDataDesc')
            : confirmation.preview?.scope === 'selected' ? t('backup.selectedImportDesc') : t('configTransfer.fullOverwriteWarning')}</p>
          <p className="mb-4 break-all text-xs text-muted-foreground">{confirmation.path}</p>
          {!!confirmation.preview?.warnings.length && <p className="mb-4 text-sm text-destructive">{t('backup.importWarnings')}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>{t('configTransfer.cancel')}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmImport()}>{t('configTransfer.confirmImport')}</Button>
          </div>
        </Modal>
      )}
    </Card>
  )
}
