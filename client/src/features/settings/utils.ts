import { matchRealEndpoint, realInputEndpoints, stripUsbIds } from '@/services/audio'
import type { MicEndpoint } from '@/services/audio'

export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

export {
  displayAccelerator,
  eventToAccelerator,
  getSingleKeyDisplay,
  keyEventToShortcutCandidate,
  resolveSingleKeyShortcut,
} from '@/lib/shortcutKeys'

export interface MicOption {
  value: string
  label: string
  title: string
}

const SYSTEM_DEFAULT_PSEUDO_ID = 'default'

export function buildMicOptions(
  devices: MicEndpoint[],
  selectedMic: string,
  labels: {
    systemDefault: string
    systemDefaultWith: (deviceName: string) => string
    unnamed: (idPrefix: string) => string
    unavailable: string
  },
): MicOption[] {
  const pseudoDefault = devices.find(
    (device) => device.deviceId.trim().toLowerCase() === SYSTEM_DEFAULT_PSEUDO_ID,
  )
  const resolvedDefault = pseudoDefault ? matchRealEndpoint(pseudoDefault, devices) : null
  const resolvedName = stripUsbIds(resolvedDefault?.label ?? '')

  const withTitle = (value: string, label: string): MicOption => ({ value, label, title: label })

  const options: MicOption[] = [
    withTitle('', resolvedName ? labels.systemDefaultWith(resolvedName) : labels.systemDefault),
    ...realInputEndpoints(devices).map((device) => withTitle(
      device.deviceId,
      stripUsbIds(device.label) || labels.unnamed(device.deviceId.slice(0, 8)),
    )),
  ]
  if (selectedMic && !options.some((option) => option.value === selectedMic)) {
    options.push(withTitle(selectedMic, labels.unavailable))
  }
  return options
}
