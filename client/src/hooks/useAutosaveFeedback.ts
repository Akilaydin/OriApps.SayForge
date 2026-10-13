import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { showToast } from '@/services/actionFeedback'
import { t } from '@/i18n'

/** Keep every save in order; a later edit cannot be overwritten by an older write. */
export function useAutosaveFeedback<T>(value: T, ready: boolean, save: (value: T) => Promise<void>, notice?: MutableRefObject<string | undefined>) {
  const [status, setStatus] = useState('')
  const queue = useRef(Promise.resolve())
  const generation = useRef(0)
  useEffect(() => {
    if (!ready) return
    const current = ++generation.current
    let active = true
    const message = notice?.current
    if (notice) notice.current = undefined
    setStatus(t('feedback.saving'))
    queue.current = queue.current.then(() => save(value)).then(() => {
      if (current === generation.current) {
        if (active) setStatus(t('feedback.saved'))
        if (message) showToast('success', message)
      }
    }, () => {
      if (current !== generation.current) return
      if (active) setStatus(t('feedback.saveFailed'))
      showToast('error', t('feedback.saveFailed'))
    })
    return () => { active = false }
  }, [value, ready, save, notice])
  return status
}
