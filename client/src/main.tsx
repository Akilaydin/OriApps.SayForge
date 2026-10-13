import { startWebviewKeyboardFallback } from './services/webviewKeyboardFallback'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { addRuntimeEvent, reportRuntimeFailure } from './services/debugLog'
import { showToast } from './services/actionFeedback'
import { failureMessage } from './lib/errorMessages'
import { Feedback } from './components/ui/feedback'
import { t } from './i18n'
import { initProviderFromStore } from './services/transcription'
import { initLanguage } from './stores/language'
import { initProviderDefaults } from './stores/providerDefaults'

window.addEventListener('error', (event) => {
  const error = event.error ?? event.message
  addRuntimeEvent('error', 'window', 'Uncaught frontend error', {
    error,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  })
  showToast('error', failureMessage(error, t('feedback.actionFailed')))
})

window.addEventListener('unhandledrejection', (event) => {
  reportRuntimeFailure('promise', 'unhandled_rejection', event.reason)
  showToast('error', failureMessage(event.reason, t('feedback.actionFailed')))
})

const root = ReactDOM.createRoot(document.getElementById('root')!)

async function bootstrap() {
  try {
    initLanguage()
    await initProviderDefaults()
    await initProviderFromStore()
    void startWebviewKeyboardFallback().catch((error) => {
      reportRuntimeFailure('keyboard', 'webview_fallback', error, 'warn')
    })
    root.render(<HashRouter><App /></HashRouter>)
  } catch (error) {
    reportRuntimeFailure('startup', 'initialize', error)
    root.render(<main className="flex min-h-screen items-center justify-center p-6">
      <Feedback tone="error" className="max-w-lg"
        message={failureMessage(error, t('startup.failed'))}
        actions={[{ label: t('common.retry'), onClick: () => { void bootstrap() } }]} />
    </main>)
  }
}

void bootstrap()
