import { isPseudoInputDevice, matchRealEndpoint, stripUsbIds } from '../audio'
import type { ActiveMicrophoneInfo, MicEndpoint } from '../audio'

export type MicSourceMode = 'auto' | 'fixed'

export interface MicSourceDescriptor {
  identity: string
  mode: MicSourceMode
  label: string
}

export function cleanActiveMicLabel(label: string): string {
  return stripUsbIds(label.replace(/^\s*(?:default|communications)\s*[-\u2013\u2014:]\s*/i, ''))
}

export function describeMicSource(
  active: ActiveMicrophoneInfo,
  requestedDeviceId: string,
  fallbackLabel: string,
  devices: MicEndpoint[] = active.devices ?? [],
): MicSourceDescriptor {
  const mode: MicSourceMode = requestedDeviceId ? 'fixed' : 'auto'
  const real = matchRealEndpoint(active, devices)

  //
  //
  const label = stripUsbIds(real?.label ?? '') || cleanActiveMicLabel(active.label) || fallbackLabel

  const deviceId = real?.deviceId.trim() || active.deviceId.trim()
  const groupId = real?.groupId.trim() || active.groupId.trim()

  const physicalIdentity = !isPseudoInputDevice(deviceId)
    ? `device:${deviceId}`
    : groupId
      ? `group:${groupId}:${label.toLocaleLowerCase()}`
      : `label:${label.toLocaleLowerCase()}`

  // The routing mode is intentional user-facing information. Switching between
  // auto-detect and a fixed endpoint should be confirmed even if both resolve to
  // the same physical microphone.
  return {
    identity: `${mode}:${physicalIdentity}`,
    mode,
    label,
  }
}

export function micSourceChanged(previousIdentity: string | null, nextIdentity: string): boolean {
  return previousIdentity !== nextIdentity
}
