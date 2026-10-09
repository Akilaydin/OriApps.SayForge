export const DEFAULT_MIC_GAIN_ENABLED = true
export const DEFAULT_MIC_GAIN_DB = 6
export const MIN_MIC_GAIN_DB = 0
export const MAX_MIC_GAIN_DB = 18

export interface MicGainSettings {
  enabled: boolean
  db: number
}

export function normalizeMicGainDb(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MIC_GAIN_DB
  return Math.max(MIN_MIC_GAIN_DB, Math.min(MAX_MIC_GAIN_DB, Math.round(value)))
}

export function microphoneGainMultiplier({ enabled, db }: MicGainSettings): number {
  return enabled ? Math.pow(10, normalizeMicGainDb(db) / 20) : 1
}
