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

describe('麦克风下拉的选项', () => {
  it('保留括号里的型号，只剥掉结尾的 USB 标识', () => {
    const options = buildMicOptions(snapshot, '', labels)

    expect(options.map((option) => option.value)).toEqual(['', 'real-headset'])
    expect(options[1].label).toBe(SHOWN)
    expect(options[1].label).not.toContain('047f')
  })

  it('「系统默认」写明它当前指向哪个设备', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options[0]).toEqual({
      value: '',
      label: `系统默认（${SHOWN}）`,
      title: `系统默认（${SHOWN}）`,
    })
  })

  it('伪设备不单独成项', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options.some((option) => option.value === 'default')).toBe(false)
    expect(options.some((option) => option.value === 'communications')).toBe(false)
  })

  it('伪设备的 groupId 为空时靠后缀匹配解析出系统默认指向谁', () => {
    const noGroup: MicEndpoint[] = [
      { deviceId: 'default', groupId: '', label: `默认值 - ${RAW}` },
      { deviceId: 'real-headset', groupId: 'plt-group', label: RAW },
    ]
    expect(buildMicOptions(noGroup, '', labels)[0].label).toBe(`系统默认（${SHOWN}）`)
  })

  it('解析不出系统默认指向谁时，退回朴素的「系统默认」而不是显示空括号', () => {
    const orphan: MicEndpoint[] = [
      { deviceId: 'default', groupId: 'gone', label: '默认值 - 某个已消失的设备' },
    ]
    expect(buildMicOptions(orphan, '', labels)[0].label).toBe('系统默认')
    expect(buildMicOptions([], '', labels)[0].label).toBe('系统默认')
  })

  it('每一项都带完整名字的 title，截断之后还能悬停看到', () => {
    const options = buildMicOptions(snapshot, '', labels)
    expect(options.every((option) => option.title === option.label)).toBe(true)
  })

  it('读不到名字时给一个带 id 前缀的兜底标签，不渲染空白项', () => {
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

  it('选中的设备不在列表里时补一条占位项', () => {
    const options = buildMicOptions(snapshot, 'gone-device', labels)

    expect(options.map((option) => option.value)).toEqual(['', 'real-headset', 'gone-device'])
    expect(options[2].label).toBe('上次选的麦克风当前不可用')
  })

  it('选中系统默认或列表里的设备时都不补占位项', () => {
    expect(buildMicOptions(snapshot, '', labels)).toHaveLength(2)
    expect(buildMicOptions(snapshot, 'real-headset', labels)).toHaveLength(2)
  })

  it('设备列表还没加载出来时，系统默认仍然是可选中的', () => {
    expect(buildMicOptions([], '', labels)).toEqual([
      { value: '', label: '系统默认', title: '系统默认' },
    ])
  })
})
