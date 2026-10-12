
import { useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import {
  getTextPostProcessOptions,
  saveTextPostProcessOptions,
  DEFAULT_POST_PROCESS,
  type TextPostProcessOptions,
} from '@/services/textPostProcess'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

interface ToggleDef {
  key: keyof TextPostProcessOptions
  titleKey: TranslationKey
  hintKey: TranslationKey
  detailKey: TranslationKey
}

const TOGGLES: ToggleDef[] = [
  {
    key: 'autoSegment',
    titleKey: 'textFormat.autoSegment.title',
    hintKey: 'textFormat.autoSegment.hint',
    detailKey: 'textFormat.autoSegment.help',
  },
  {
    key: 'stripTrailingPunctuation',
    titleKey: 'textFormat.stripTrailing.title',
    hintKey: 'textFormat.stripTrailing.hint',
    detailKey: 'textFormat.stripTrailing.help',
  },
  {
    key: 'punctuationToSpace',
    titleKey: 'textFormat.punctuationToSpace.title',
    hintKey: 'textFormat.punctuationToSpace.hint',
    detailKey: 'textFormat.punctuationToSpace.help',
  },
]

export default function TextFormatSection() {
  const t = useT()
  const [opts, setOpts] = useState<TextPostProcessOptions>(DEFAULT_POST_PROCESS)
  const initialized = useRef(false)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    getTextPostProcessOptions()
      .then((loaded) => {
        setOpts(loaded)
        initialized.current = true
      })
      .finally(() => {
        setReady(true)
        requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)))
      })
  }, [])

  useEffect(() => {
    if (!initialized.current) return
    void saveTextPostProcessOptions(opts)
  }, [opts])

  const toggle = (key: keyof TextPostProcessOptions) => {
    setOpts((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="mb-6 rounded-lg border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold">{t('textFormat.title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('textFormat.desc')}
        </p>
      </div>
      <div className="divide-y divide-border/60">
        {TOGGLES.map((def) => {
          return (
            <div key={def.key} className="flex items-center gap-2.5 px-4 py-2.5">
              <Switch
                checked={opts[def.key]}
                onChange={() => toggle(def.key)}
                size="sm"
                noAnimation={!animate}
                hidden={!ready}
                className="shrink-0"
              />
              <span className="shrink-0 text-sm font-medium">
                {t(def.titleKey)}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {t(def.hintKey)}
                </span>
                <Tooltip
                  content={t(def.detailKey)}
                  variant="light"
                >
                  <HelpCircle className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 hover:text-muted-foreground" />
                </Tooltip>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
