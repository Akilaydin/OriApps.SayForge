import { describe, expect, it } from 'vitest'

import capabilitiesSource from '../../../src-tauri/src/providers/capabilities.rs?raw'

import {
  foldHotwordDelivery,
  hotwordUndecidedReason,
  type HotwordDelivery,
} from '../asrModels'
import { ASR_PROVIDERS, asrModelsOf } from '@/features/settings/asrProviderCatalog'


describe('foldHotwordDelivery', () => {
  it('三种会进请求的传递方式都折成「已发送」', () => {
    for (const delivery of ['vocabulary', 'context', 'instruction'] as HotwordDelivery[]) {
      expect(foldHotwordDelivery(delivery)).toBe('sent')
    }
  })

  it('协议没位置和我们没接，对用户都是「不发送」', () => {
    expect(foldHotwordDelivery('protocol_has_no_slot')).toBe('not_sent')
    expect(foldHotwordDelivery('not_wired_up')).toBe('not_sent')
  })

  it('声明缺失绝不能显示成「确定不发送」', () => {
    expect(foldHotwordDelivery('unknown_provider')).toBe('undecided')
    expect(foldHotwordDelivery('unknown_provider')).not.toBe('not_sent')
    expect(foldHotwordDelivery('unknown_provider')).not.toBe('sent')
  })

  it('auto 协议在探测出来之前也是「未确定」，不能猜', () => {
    expect(foldHotwordDelivery('undecided_protocol')).toBe('undecided')
  })
})

function parseAllAsrProviders(rustSource: string): string[] {
  const block = /ALL_ASR_PROVIDERS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(rustSource)
  if (!block) {
    throw new Error(
      '在 capabilities.rs 里找不到 ALL_ASR_PROVIDERS 的定义 —— 常量被改名或换了写法，'
      + '这条跨语言断言已经失效，必须同步改这里的解析',
    )
  }
  const keys = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (keys.length === 0) {
    throw new Error('ALL_ASR_PROVIDERS 解析出 0 个 key，解析逻辑已失效')
  }
  return keys
}

function declaredProvidersInRust(): Set<string> {
  return new Set(parseAllAsrProviders(capabilitiesSource))
}

const FAKE_DECLARATION = `
pub const ALL_ASR_PROVIDERS: &[&str] = &[
    "alpha",
    "beta",
    "gamma",
];
`

describe('目录里每个模型的运行时 provider 都在 Rust 声明过热词行为', () => {
  const DECLARED_IN_RUST = declaredProvidersInRust()

  it('读到的声明清单是真实的、非空的', () => {
    expect(DECLARED_IN_RUST.size).toBe(4)
    expect(DECLARED_IN_RUST.has('openai_chat_audio')).toBe(true)
  })

  it('解析器认得 Rust 的清单写法', () => {
    expect(parseAllAsrProviders(FAKE_DECLARATION)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('Rust 清单少一个 key，这边就少一个', () => {
    const shrunk = FAKE_DECLARATION.replace('    "beta",\n', '')
    expect(shrunk).not.toBe(FAKE_DECLARATION)
    expect(parseAllAsrProviders(shrunk)).toEqual(['alpha', 'gamma'])
  })

  it('解析不到时抛错而不是返回空集', () => {
    expect(() => parseAllAsrProviders('pub const SOMETHING_ELSE: &[&str] = &["x"];')).toThrow()
    expect(() => parseAllAsrProviders('pub const ALL_ASR_PROVIDERS: &[&str] = &[];')).toThrow()
  })

  it('遍历的是模型上的 provider，不是卡片 id', () => {
    const cardIds = new Set(ASR_PROVIDERS.map((entry) => entry.id))
    const modelProviders = new Set(
      ASR_PROVIDERS.flatMap((entry) => asrModelsOf(entry).map((model) => model.provider)),
    )
    expect(modelProviders.has('openai_compat')).toBe(true)
    expect(modelProviders.has('openai_live_transcribe')).toBe(false)
    expect(cardIds.has('openai_transcribe')).toBe(false)
  })

  it('每个模型的 provider 都有声明', () => {
    for (const entry of ASR_PROVIDERS) {
      for (const model of asrModelsOf(entry)) {
        expect(
          DECLARED_IN_RUST.has(model.provider),
          `${entry.id} / ${model.id} 的 provider "${model.provider}" 在 Rust 的热词声明清单里找不到`,
        ).toBe(true)
      }
    }
  })
})

describe('hotwordUndecidedReason', () => {
  it('auto 协议未探测是唯一能靠"再用一次"解决的那种', () => {
    expect(hotwordUndecidedReason('undecided_protocol')).toBe('protocol')
  })

  it('声明缺失要单独指认，不能说成"等下次识别"', () => {
    expect(hotwordUndecidedReason('unknown_provider')).toBe('declaration_missing')
    expect(hotwordUndecidedReason('unknown_provider')).not.toBe('protocol')
  })

  it('确定的那些档位没有未确定原因', () => {
    for (const delivery of [
      'vocabulary', 'context', 'instruction', 'not_wired_up', 'protocol_has_no_slot',
    ] as HotwordDelivery[]) {
      expect(hotwordUndecidedReason(delivery)).toBeNull()
    }
  })

  it('凡是折成「未确定」的档位都能给出原因', () => {
    const all: HotwordDelivery[] = [
      'vocabulary', 'context', 'instruction',
      'protocol_has_no_slot', 'not_wired_up',
      'undecided_protocol', 'unknown_provider',
    ]
    for (const delivery of all) {
      const isUndecided = foldHotwordDelivery(delivery) === 'undecided'
      expect(hotwordUndecidedReason(delivery) !== null).toBe(isUndecided)
    }
  })
})
