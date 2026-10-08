import { Github, ExternalLink } from 'lucide-react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import appIcon from '@/assets/icon-128.png'
import { useT } from '@/i18n/useT'

const REPO_URL = 'https://github.com/Akilaydin/OriApps.SayForge'
const RELEASES_URL = `${REPO_URL}/releases`
const UPSTREAM_URL = 'https://github.com/crosswk/SayIt'
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

export default function About() {
  const t = useT()
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">{t('about.title')}</h1>
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <img src={appIcon} alt="SayForge" className="h-16 w-16 rounded-2xl" />
            <div>
              <h2 className="text-2xl font-bold tracking-tight">SayForge</h2>
              <p className="text-sm text-muted-foreground">{t('about.tagline')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground/70">{t('about.oriApps')}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void shellOpen(REPO_URL)}>
                  <Github className="mr-1.5 h-4 w-4" />
                  GitHub
                </Button>
                <span className="text-xs text-muted-foreground">v{__APP_VERSION__}</span>
              </div>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-2 text-sm font-medium">{t('about.updateSection')}</h3>
            <p className="mb-3 text-sm text-muted-foreground">{t('about.manualReleaseNote')}</p>
            <Button variant="outline" size="sm" onClick={() => void shellOpen(RELEASES_URL)}>
              <ExternalLink className="mr-1.5 h-4 w-4" />
              {t('about.openReleases')}
            </Button>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-2 text-sm font-medium">{t('about.acknowledgements')}</h3>
            <p className="mb-2 text-sm text-muted-foreground">{t('about.basedOnSayIt')}</p>
            <Button variant="ghost" size="sm" onClick={() => void shellOpen(UPSTREAM_URL)}>
              <ExternalLink className="mr-1.5 h-4 w-4" />
              {t('about.originalProject')}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              GNU Affero General Public License v3.0 (AGPL-3.0). {t('about.noWarranty')}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void shellOpen(LICENSE_URL)}>
              <ExternalLink className="mr-1.5 h-4 w-4" />
              {t('about.viewLicense')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
