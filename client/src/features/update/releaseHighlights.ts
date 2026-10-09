//

export interface ReleaseHighlights {
  version: string
  items: string[]
}

export const RELEASE_HIGHLIGHTS: ReleaseHighlights = {
  // The inherited v0.2.2 notes describe providers removed from this edition.
  // Reintroduce release highlights when SayForge publishes an independent release.
  version: '0.2.2',
  get items() {
    return []
  },
}
