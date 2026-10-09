import { describe, expect, it } from 'vitest'
import type { MicEndpoint } from '@/services/audio'
import { buildMicOptions } from '../utils'

const labels = {
  systemDefault: 'System default',
  systemDefaultWith: (device: string) => `System default (${device})`,
  unnamed: (idPrefix: string) => `Microphone ${idPrefix}`,
  unavailable: 'Previously selected microphone is unavailable',
}

const RAW = 'Headset Microphone (Plantronics Blackwire 5220 Series) (047f:c053)'
const SHOWN = 'Headset Microphone (Plantronics Blackwire 5220 Series)'

const snapshot: MicEndpoint[] = [
  { deviceId: 'default', groupId: 'plt-group', label: `Default - ${RAW}` },
  { deviceId: 'communications', groupId: 'plt-group', label: `Communications - ${RAW}` },
  { deviceId: 'real-headset', groupId: 'plt-group', label: RAW },
]

describe('microphone options', () => {
  it('preserves the model and removes only the USB suffix', () => {
    const options = buildMicOptions(snapshot, '', labels)

    expect(options.map((option) => option.value)).toEqual(['', 'real-headset'])
    expect(options[1].label).toBe(SHOWN)
    expect(options[1].label).not.toContain('047f')
  })

  it('labels the endpoint behind system default', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options[0]).toEqual({
      value: '',
      label: `System default (${SHOWN})`,
      title: `System default (${SHOWN})`,
    })
  })

  it('hides pseudo devices as separate options', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options.some((option) => option.value === 'default')).toBe(false)
    expect(options.some((option) => option.value === 'communications')).toBe(false)
  })

  it('matches default by label suffix when groupId is empty', () => {
    const noGroup: MicEndpoint[] = [
      { deviceId: 'default', groupId: '', label: `Default - ${RAW}` },
      { deviceId: 'real-headset', groupId: 'plt-group', label: RAW },
    ]
    expect(buildMicOptions(noGroup, '', labels)[0].label).toBe(`System default (${SHOWN})`)
  })

  it('uses a plain default label for an unresolved endpoint', () => {
    const orphan: MicEndpoint[] = [
      { deviceId: 'default', groupId: 'gone', label: 'Default - Missing device' },
    ]
    expect(buildMicOptions(orphan, '', labels)[0].label).toBe('System default')
    expect(buildMicOptions([], '', labels)[0].label).toBe('System default')
  })

  it('retains full labels in option titles', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options.every((option) => option.title === option.label)).toBe(true)
  })

  it('uses an ID prefix when device labels are missing', () => {
    const unnamed: MicEndpoint[] = [
      { deviceId: 'abcdef1234567890', groupId: 'g', label: '' },
    ]
    expect(buildMicOptions(unnamed, '', labels).map((option) => option.value)).toEqual([''])
    const selected = buildMicOptions(unnamed, 'abcdef1234567890', labels)
    expect(selected[selected.length - 1]).toEqual({
      value: 'abcdef1234567890',
      label: 'Previously selected microphone is unavailable',
      title: 'Previously selected microphone is unavailable',
    })
  })

  it('adds a placeholder for an unavailable selection', () => {
    const options = buildMicOptions(snapshot, 'gone-device', labels)

    expect(options.map((option) => option.value)).toEqual(['', 'real-headset', 'gone-device'])
    expect(options[2].label).toBe('Previously selected microphone is unavailable')
  })

  it('does not add a placeholder for valid selections', () => {
    expect(buildMicOptions(snapshot, '', labels)).toHaveLength(2)
    expect(buildMicOptions(snapshot, 'real-headset', labels)).toHaveLength(2)
  })

  it('keeps system default selectable before devices load', () => {
    expect(buildMicOptions([], '', labels)).toEqual([
      { value: '', label: 'System default', title: 'System default' },
    ])
  })
})
