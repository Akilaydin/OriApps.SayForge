import { describe, expect, it } from 'vitest'
import type { MicEndpoint } from '@/services/audio'
import { buildMicOptions } from '../utils'

const labels = {
  systemDefault: '系统默认',
  systemDefaultWith: (device: string) => `系统默认（${device}）`,
  unnamed: (idPrefix: string) => `麦克风 ${idPrefix}`,
  unavailable: '上次选的麦克风当前不可用',
}

const RAW = '耳机式麦克风 (Plantronics Blackwire 5220 Series) (047f:c053)'
const SHOWN = '耳机式麦克风 (Plantronics Blackwire 5220 Series)'

const snapshot: MicEndpoint[] = [
  { deviceId: 'default', groupId: 'plt-group', label: `默认值 - ${RAW}` },
  { deviceId: 'communications', groupId: 'plt-group', label: `通信设备 - ${RAW}` },
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
      label: `系统默认（${SHOWN}）`,
      title: `系统默认（${SHOWN}）`,
    })
  })

  it('hides pseudo devices as separate options', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options.some((option) => option.value === 'default')).toBe(false)
    expect(options.some((option) => option.value === 'communications')).toBe(false)
  })

  it('matches default by label suffix when groupId is empty', () => {
    const noGroup: MicEndpoint[] = [
      { deviceId: 'default', groupId: '', label: `默认值 - ${RAW}` },
      { deviceId: 'real-headset', groupId: 'plt-group', label: RAW },
    ]
    expect(buildMicOptions(noGroup, '', labels)[0].label).toBe(`系统默认（${SHOWN}）`)
  })

  it('uses a plain default label for an unresolved endpoint', () => {
    const orphan: MicEndpoint[] = [
      { deviceId: 'default', groupId: 'gone', label: '默认值 - 某个已消失的设备' },
    ]
    expect(buildMicOptions(orphan, '', labels)[0].label).toBe('系统默认')
    expect(buildMicOptions([], '', labels)[0].label).toBe('系统默认')
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
      label: '上次选的麦克风当前不可用',
      title: '上次选的麦克风当前不可用',
    })
  })

  it('adds a placeholder for an unavailable selection', () => {
    const options = buildMicOptions(snapshot, 'gone-device', labels)

    expect(options.map((option) => option.value)).toEqual(['', 'real-headset', 'gone-device'])
    expect(options[2].label).toBe('上次选的麦克风当前不可用')
  })

  it('does not add a placeholder for valid selections', () => {
    expect(buildMicOptions(snapshot, '', labels)).toHaveLength(2)
    expect(buildMicOptions(snapshot, 'real-headset', labels)).toHaveLength(2)
  })

  it('keeps system default selectable before devices load', () => {
    expect(buildMicOptions([], '', labels)).toEqual([
      { value: '', label: '系统默认', title: '系统默认' },
    ])
  })
})
