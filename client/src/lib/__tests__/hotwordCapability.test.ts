import { describe, expect, it } from 'vitest'

import capabilitiesSource from '../../../src-tauri/src/providers/capabilities.rs?raw'

import {
  foldHotwordDelivery,
  hotwordUndecidedReason,
  type HotwordDelivery,
} from '../asrModels'
import { ASR_PROVIDERS, asrModelsOf } from '@/features/settings/asrProviderCatalog'


describe('foldHotwordDelivery', () => {
  it('folds all supported delivery forms into sent', () => {
    for (const delivery of ['vocabulary', 'context', 'instruction'] as HotwordDelivery[]) {
      expect(foldHotwordDelivery(delivery)).toBe('sent')
    }
  })

  it('folds unavailable delivery into not sent', () => {
    expect(foldHotwordDelivery('protocol_has_no_slot')).toBe('not_sent')
    expect(foldHotwordDelivery('not_wired_up')).toBe('not_sent')
  })

  it('missing declarations remain undecided', () => {
    expect(foldHotwordDelivery('unknown_provider')).toBe('undecided')
    expect(foldHotwordDelivery('unknown_provider')).not.toBe('not_sent')
    expect(foldHotwordDelivery('unknown_provider')).not.toBe('sent')
  })

  it('automatic protocol remains undecided before detection', () => {
    expect(foldHotwordDelivery('undecided_protocol')).toBe('undecided')
  })
})

function parseAllAsrProviders(rustSource: string): string[] {
  const block = /ALL_ASR_PROVIDERS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(rustSource)
  if (!block) {
    throw new Error(
      'ALL_ASR_PROVIDERS is missing from capabilities.rs; its declaration may have changed. '
      + 'Update the cross-language source parser before relying on this assertion.',
    )
  }
  const keys = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (keys.length === 0) {
    throw new Error('ALL_ASR_PROVIDERS parsed zero keys; the source parser is stale')
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

describe('catalog runtime providers have native capability declarations', () => {
  const DECLARED_IN_RUST = declaredProvidersInRust()

  it('reads a real nonempty declaration list', () => {
    expect(DECLARED_IN_RUST.size).toBe(4)
    expect(DECLARED_IN_RUST.has('openai_chat_audio')).toBe(true)
  })

  it('parses the Rust declaration syntax', () => {
    expect(parseAllAsrProviders(FAKE_DECLARATION)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('detects a removed declaration', () => {
    const shrunk = FAKE_DECLARATION.replace('    "beta",\n', '')
    expect(shrunk).not.toBe(FAKE_DECLARATION)
    expect(parseAllAsrProviders(shrunk)).toEqual(['alpha', 'gamma'])
  })

  it('throws for missing or empty declarations', () => {
    expect(() => parseAllAsrProviders('pub const SOMETHING_ELSE: &[&str] = &["x"];')).toThrow()
    expect(() => parseAllAsrProviders('pub const ALL_ASR_PROVIDERS: &[&str] = &[];')).toThrow()
  })

  it('checks model providers rather than card IDs', () => {
    const cardIds = new Set(ASR_PROVIDERS.map((entry) => entry.id))
    const modelProviders = new Set(
      ASR_PROVIDERS.flatMap((entry) => asrModelsOf(entry).map((model) => model.provider)),
    )
    expect(modelProviders.has('openai_compat')).toBe(true)
    expect(modelProviders.has('openai_live_transcribe')).toBe(false)
    expect(cardIds.has('openai_transcribe')).toBe(false)
  })

  it('every model provider is declared', () => {
    for (const entry of ASR_PROVIDERS) {
      for (const model of asrModelsOf(entry)) {
        expect(
          DECLARED_IN_RUST.has(model.provider),
          `${entry.id} / ${model.id} provider "${model.provider}" has no Rust hotword declaration`,
        ).toBe(true)
      }
    }
  })
})

describe('hotwordUndecidedReason', () => {
  it('only protocol detection can resolve uncertainty by retrying', () => {
    expect(hotwordUndecidedReason('undecided_protocol')).toBe('protocol')
  })

  it('distinguishes missing declarations from pending detection', () => {
    expect(hotwordUndecidedReason('unknown_provider')).toBe('declaration_missing')
    expect(hotwordUndecidedReason('unknown_provider')).not.toBe('protocol')
  })

  it('known capabilities have no undecided reason', () => {
    for (const delivery of [
      'vocabulary', 'context', 'instruction', 'not_wired_up', 'protocol_has_no_slot',
    ] as HotwordDelivery[]) {
      expect(hotwordUndecidedReason(delivery)).toBeNull()
    }
  })

  it('all undecided capabilities have a reason', () => {
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
