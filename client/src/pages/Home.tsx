import { useEffect, useState } from 'react'
import { getSetting } from '@/services/store'
import { SHORTCUTS_CHANGED_EVENT } from '@/services/bridge'
import { displayShortcut } from '@/lib/shortcutKeys'
import { useT } from '@/i18n/useT'

function WithKeyChip({ template, keyLabel, chipClassName }: {
  template: string
  keyLabel: string
  chipClassName: string
}) {
  const [before, after = ''] = template.split('{key}')
  return (
    <>
      {before}
      <span className={chipClassName}>{keyLabel}</span>
      {after}
    </>
  )
}

export default function Home() {
  const t = useT()
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')

  useEffect(() => {
    const loadHandsFreeKey = () =>
      getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string))
    void loadHandsFreeKey()
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, loadHandsFreeKey)
    return () => window.removeEventListener(SHORTCUTS_CHANGED_EVENT, loadHandsFreeKey)
  }, [])

  const handsFreeKeyLabel = displayShortcut(handsFreeKey).join(' + ')

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="mb-4 text-2xl font-bold">{t('home.title')}</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        <WithKeyChip
          template={t('home.subtitle')}
          keyLabel={handsFreeKeyLabel}
          chipClassName="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded"
        />
      </p>


        <div className="mb-6 rounded-xl border border-border bg-muted/30 px-5 py-5 text-center">
          <p className="text-sm text-muted-foreground">
            <WithKeyChip
              template={t('home.newUserHint')}
              keyLabel={handsFreeKeyLabel}
              chipClassName="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded text-xs"
            />
          </p>
        </div>


    </div>
  )
}
