import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appendDebugLog: vi.fn() }))

vi.mock('../bridge', () => ({ appendDebugLog: mocks.appendDebugLog }))

import {
  addRuntimeEvent,
  AI_EVENT_OUTCOME,
  AI_EVENT_REQUEST,
  AI_LOG_SOURCE,
  clearRuntimeEvents,
  getRuntimeEvents,
} from '../debugLog'

interface MirroredPayload {
  kind?: string
  level?: string
  source?: string
  message?: string
  detail?: unknown
}

function mirrored(): MirroredPayload[] {
  return mocks.appendDebugLog.mock.calls.map((call) => call[0] as MirroredPayload)
}

function mirroredMessages(): string[] {
  return mirrored()
    .filter((p) => p.kind === 'runtime')
    .map((p) => p.message ?? '')
}

describe('AI 事件必须真的穿过落盘过滤层', () => {
  beforeEach(() => {
    mocks.appendDebugLog.mockClear()
    clearRuntimeEvents()
  })

  it.each([AI_EVENT_OUTCOME, AI_EVENT_REQUEST])('%s 会被镜像到主日志', (event) => {
    addRuntimeEvent('info', AI_LOG_SOURCE, event, { operationId: 'op-x' })
    expect(mirroredMessages()).toContain(event)
  })

  it.each([AI_EVENT_OUTCOME, AI_EVENT_REQUEST])('%s 也会进内存运行事件（两处判据必须同步）', (event) => {
    addRuntimeEvent('info', AI_LOG_SOURCE, event, { operationId: 'op-y' })
    const kept = getRuntimeEvents().filter((e) => e.message === event)
    expect(kept.length).toBeGreaterThan(0)
  })

  it('同来源的其它 info 事件仍然被过滤掉（放行面只有这两个，不是整个 ai 来源）', () => {
    addRuntimeEvent('info', AI_LOG_SOURCE, 'ai.some.debug.chatter', { noise: true })
    expect(mirroredMessages()).not.toContain('ai.some.debug.chatter')
  })

  it('旧路径那条按 provider 命名的 info 依然不落盘（说明本轮的修法是必要的）', () => {
    for (const source of ['server', 'local', 'cloud_api', 'history']) {
      addRuntimeEvent('info', source, 'AI cleanup skipped below duration threshold', {})
    }
    expect(mirroredMessages()).not.toContain('AI cleanup skipped below duration threshold')
  })

  it('warn 级别不受白名单限制（自配 AI 失败详情靠它落盘）', () => {
    addRuntimeEvent('warn', 'server', 'Custom AI cleanup failed; using raw ASR text', { error: 'boom' })
    expect(mirroredMessages()).toContain('Custom AI cleanup failed; using raw ASR text')
  })
})
