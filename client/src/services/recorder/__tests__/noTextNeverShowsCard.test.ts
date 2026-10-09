import { describe, expect, it } from 'vitest'

import SOURCE from '../RecorderOrchestrator.ts?raw'

const CARD_ENTRY_POINTS = ['showFailure(', 'failRunWithCard(']

const CARD_TITLE_KEYS = [
  'recorder.emptyAfterProcessingTitle',
  'recorder.protocolIncompleteTitle',
  'recorder.connectionLostTitle',
  'recorder.processingTimeoutTitle',
  'recorder.recognitionFailedTitle',
]

describe('识别没出文字不弹卡片', () => {
  it('源码读到了，不是空字符串（否则下面几条会假绿）', () => {
    expect(SOURCE.length).toBeGreaterThan(1000)
    expect(SOURCE).toContain('showNoSpeech')
  })

  it('卡片入口一个都没少认', () => {
    for (const entry of CARD_ENTRY_POINTS) {
      expect(SOURCE, `卡片入口 ${entry} 在源码里找不到了，先确认它是不是改名了`)
        .toContain(entry)
    }
  })

  it('没有任何一处取用已删除的「没有取得识别结果」文案', () => {
    expect(SOURCE).not.toContain("t('recorder.noResultTitle')")
    expect(SOURCE).not.toContain("t('recorder.noResultDetail')")
  })

  it('每一处卡片的标题都在白名单里', () => {
    const titles: string[] = []
    for (const entry of CARD_ENTRY_POINTS) {
      let from = 0
      for (; ;) {
        const at = SOURCE.indexOf(entry, from)
        if (at < 0) break
        from = at + entry.length
        const window = SOURCE.slice(at, at + 400)
        const matched = /title:\s*t\('([^']+)'\)/.exec(window)
        if (matched) titles.push(matched[1])
      }
    }

    expect(titles.length).toBeGreaterThan(0)
    for (const title of titles) {
      expect(CARD_TITLE_KEYS, `卡片标题 ${title} 不在白名单里`).toContain(title)
    }
  })

  it('两条空结果路径都调了 showNoSpeech，且都带 no_text 分支', () => {
    const noSpeechCalls = SOURCE.match(/showNoSpeech\(/g) ?? []
    expect(noSpeechCalls.length).toBeGreaterThanOrEqual(3)
    const noTextBranches = SOURCE.match(/silenceProven \? 'silent' : 'no_text'/g) ?? []
    expect(noTextBranches.length).toBe(2)
  })
})
