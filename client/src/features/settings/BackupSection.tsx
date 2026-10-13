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
import { runAction } from '@/services/actionFeedback'
import { useActionPending } from '@/components/ActionFeedback'

type Confirmation = { kind: 'config' | 'full'; path: string; preview?: ConfigImportPreview }

export default function BackupSection() {
  const t = useT()
  const [status, setStatus] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const busy = useActionPending('backup')

  const exportSettings = async () => {
    await runAction('backup', async () => {
      setStatus('')
      const result = await exportConfigFile({ mode: 'full' })
      if (result.filePath) setStatus(t('backup.savedTo', { path: result.filePath }))
      return !result.canceled && !!result.filePath
    }, { success: t('feedback.exported'), canceled: t('feedback.canceled'), error: t('feedback.exportFailed') })
  }

  const chooseImport = async (kind: 'config' | 'full') => {
    await runAction('backup', async () => {
      setStatus('')
      const path = await pickImportFile(kind)
      if (!path) return false
      const preview = kind === 'config' ? await inspectConfigImport(path) : undefined
      setConfirmation({ kind, path, preview })
    }, { canceled: t('feedback.canceled'), error: t('feedback.importFailed') })
  }

  const confirmImport = async () => {
    if (!confirmation) return
    await runAction('backup', async () => {
      setStatus('')
      await runImport(confirmation.kind, confirmation.path, confirmation.preview?.importToken)
      setConfirmation(null)
      setRestartRequired(true)
      setStatus(t('backup.importComplete'))
    }, { success: t('feedback.imported'), error: t('feedback.importFailed') })
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
        {restartRequired && <Button disabled={busy} onClick={() => void runAction('backup', restartApp)}>{t('backup.restart')}</Button>}
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
