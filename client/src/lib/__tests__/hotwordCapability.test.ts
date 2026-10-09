import { describe, expect, it } from 'vitest'

import capabilitiesSource from '../../../src-tauri/src/providers/capabilities.rs?raw'

import {
  expectedClientCap,
  expectedHotwordDelivery,
  foldHotwordDelivery,
  hotwordDependsOnStreamingPath,
  hotwordUndecidedReason,
  willUseStreamingPath,
  type AsrHotwordCapability,
  type HotwordDelivery,
} from '../asrModels'
import { ASR_PROVIDERS, asrModelsOf } from '@/features/settings/asrProviderCatalog'


function capability(over: Partial<AsrHotwordCapability> = {}): AsrHotwordCapability {
  return {
    streaming: 'context',
    buffered: 'context',
    hasStreamingPath: false,
    streamingClientCap: null,
    bufferedClientCap: null,
    ...over,
  }
}

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

describe('expectedHotwordDelivery', () => {
  it('没有流式实现的服务只看一次性路径', () => {
    const cap = capability({ buffered: 'not_wired_up', streaming: 'not_wired_up' })
    expect(expectedHotwordDelivery(cap, {
      streamingDisplayEnabled: true,
      provider: 'groq_whisper',
    })).toBe('not_wired_up')
  })

  it('retired OpenAI streaming always uses buffered hotword delivery', () => {
    const cap = capability({
      streaming: 'vocabulary',
      buffered: 'not_wired_up',
      hasStreamingPath: true,
      streamingClientCap: 100,
      bufferedClientCap: null,
    })
    expect(expectedHotwordDelivery(cap, {
      streamingDisplayEnabled: true,
      provider: 'openai_live_transcribe',
    })).toBe('not_wired_up')
    expect(expectedHotwordDelivery(cap, {
      streamingDisplayEnabled: false,
      provider: 'openai_live_transcribe',
    })).toBe('not_wired_up')
  })

  it('retired Gemini streaming always uses buffered hotword delivery', () => {
    const cap = capability({
      streaming: 'protocol_has_no_slot',
      buffered: 'instruction',
      hasStreamingPath: true,
    })
    expect(expectedHotwordDelivery(cap, {
      streamingDisplayEnabled: true,
      provider: 'gemini_live_transcribe',
    })).toBe('instruction')
    expect(expectedHotwordDelivery(cap, {
      streamingDisplayEnabled: false,
      provider: 'gemini_live_transcribe',
    })).toBe('instruction')
  })

  it('uses the buffered path when a removed provider has no streaming implementation', () => {
    const inverted = capability({
      streaming: 'vocabulary',
      buffered: 'not_wired_up',
      hasStreamingPath: true,
    })
    expect(expectedHotwordDelivery(inverted, {
      streamingDisplayEnabled: true,
      provider: 'qwen_realtime',
    })).toBe('not_wired_up')
    expect(expectedHotwordDelivery(inverted, {
      streamingDisplayEnabled: true,
      provider: 'openai_live_transcribe',
    })).toBe('not_wired_up')
  })
})

describe('hotwordDependsOnStreamingPath', () => {
  it('两条路径结论相同时不提醒（提醒了是噪音）', () => {
    expect(hotwordDependsOnStreamingPath(capability({
      streaming: 'context',
      buffered: 'context',
      hasStreamingPath: true,
    }))).toBe(false)
    expect(hotwordDependsOnStreamingPath(capability({
      streaming: 'vocabulary',
      buffered: 'instruction',
      hasStreamingPath: true,
    }))).toBe(false)
  })

  it('结论会被回落翻转时必须提醒', () => {
    expect(hotwordDependsOnStreamingPath(capability({
      streaming: 'vocabulary',
      buffered: 'not_wired_up',
      hasStreamingPath: true,
    }))).toBe(true)
    expect(hotwordDependsOnStreamingPath(capability({
      streaming: 'protocol_has_no_slot',
      buffered: 'instruction',
      hasStreamingPath: true,
    }))).toBe(true)
  })

  it('没有流式路径的服务不会有这个不确定性', () => {
    expect(hotwordDependsOnStreamingPath(capability({
      streaming: 'not_wired_up',
      buffered: 'not_wired_up',
      hasStreamingPath: false,
    }))).toBe(false)
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

describe('expectedClientCap', () => {
  const openaiLive = capability({
    streaming: 'vocabulary',
    buffered: 'not_wired_up',
    hasStreamingPath: true,
    streamingClientCap: 100,
    bufferedClientCap: null,
  })

  it('retired OpenAI streaming does not expose its streaming cap', () => {
    expect(expectedClientCap(openaiLive, {
      streamingDisplayEnabled: true,
      provider: 'openai_live_transcribe',
    })).toBeNull()
    expect(expectedClientCap(openaiLive, {
      streamingDisplayEnabled: false,
      provider: 'openai_live_transcribe',
    })).toBeNull()
  })

  it('retired Gemini streaming selects the buffered cap', () => {
    const geminiLive = capability({
      streaming: 'protocol_has_no_slot',
      buffered: 'instruction',
      hasStreamingPath: true,
      streamingClientCap: null,
      bufferedClientCap: 100,
    })
    expect(expectedClientCap(geminiLive, {
      streamingDisplayEnabled: true,
      provider: 'gemini_live_transcribe',
    })).toBe(100)
    expect(expectedClientCap(geminiLive, {
      streamingDisplayEnabled: false,
      provider: 'gemini_live_transcribe',
    })).toBe(100)
  })

  it('上限和 delivery 永远来自同一条路径', () => {
    for (const streamingDisplayEnabled of [true, false]) {
      const opts = { streamingDisplayEnabled, provider: 'openai_live_transcribe' }
      const delivery = expectedHotwordDelivery(openaiLive, opts)
      const cap = expectedClientCap(openaiLive, opts)
      if (delivery === 'not_wired_up' || delivery === 'protocol_has_no_slot') {
        expect(cap).toBeNull()
      }
      expect(willUseStreamingPath(openaiLive, opts)).toBe(false)
    }
  })

  it('没有流式实现的服务永远取一次性路径那份', () => {
    const gemini = capability({
      streaming: 'instruction',
      buffered: 'instruction',
      hasStreamingPath: false,
      streamingClientCap: 100,
      bufferedClientCap: 100,
    })
    expect(willUseStreamingPath(gemini, {
      streamingDisplayEnabled: true,
      provider: 'gemini_transcribe',
    })).toBe(false)
    expect(expectedClientCap(gemini, {
      streamingDisplayEnabled: true,
      provider: 'gemini_transcribe',
    })).toBe(100)
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
