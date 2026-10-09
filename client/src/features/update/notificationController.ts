import type { AutoUpdateState } from './autoUpdate'
import type { UpdateNotificationAction, UpdateNotificationData, UpdateNotificationSnapshot } from './notificationTypes'

interface NotificationDependencies {
  readUpdate: () => AutoUpdateState
  isIdle: () => boolean
  appearance: () => Pick<UpdateNotificationData, 'theme' | 'locale' | 'currentVersion'>
  publish: (snapshot: UpdateNotificationSnapshot) => Promise<void>
  install: () => Promise<void>
  onError: (error: unknown) => void
}

export class UpdateNotificationController {
  private dismissed = new Set<string>()
  private idleSince: number | null = null
  private previous: string | undefined
  private revision = Date.now()
  private queue = Promise.resolve()
  private stopped = false
  private installing = false

  constructor(private deps: NotificationDependencies) {}

  tick(now = Date.now()) {
    if (this.stopped) return
    const state = this.deps.readUpdate()
    const idle = this.deps.isIdle()
    this.idleSince = idle ? (this.idleSince ?? now) : null
    const pending = state.pending
    const ready = this.idleSince !== null && now - this.idleSince >= 2000
    const show = pending && !this.dismissed.has(pending.version) && ready
    this.publish(show ? {
      ...this.deps.appearance(),
      version: pending.version,
      installing: state.phase === 'installing',
      installFailed: !!state.installError,
    } : null)
  }

  async act(event: UpdateNotificationAction) {
    if (this.stopped || this.installing) return
    const state = this.deps.readUpdate()
    if (state.pending?.version !== event.version || state.phase === 'installing') return
    if (event.action === 'later') {
      this.dismissed.add(event.version)
      this.tick()
    } else if (event.action === 'install' && this.deps.isIdle()) {
      this.installing = true
      try {
        await this.deps.install()
      } catch (error) {
        this.deps.onError(error)
      } finally {
        this.installing = false
        this.tick()
      }
    }
  }

  stop() {
    this.stopped = true
    this.publish(null)
  }

  private publish(data: UpdateNotificationData | null) {
    const fingerprint = JSON.stringify(data)
    if (fingerprint === this.previous) return
    this.previous = fingerprint
    const snapshot = { revision: ++this.revision, data }
    this.queue = this.queue.then(async () => {
      if (snapshot.revision !== this.revision) return
      try {
        await this.deps.publish(snapshot)
      } catch (error) {
        if (snapshot.revision === this.revision) this.previous = undefined
        this.deps.onError(error)
      }
    })
  }
}
