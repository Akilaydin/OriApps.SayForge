import { getSetting } from '../store'

export type ServerAiSource = 'managed' | 'custom'
export const SERVER_AI_SOURCE_KEY = 'server.aiSource'

let runtimeSource: ServerAiSource = 'managed'

function normalizeServerAiSource(value: unknown): ServerAiSource {
  return value === 'custom' ? 'custom' : 'managed'
}

export async function loadServerAiSource(): Promise<ServerAiSource> {
  runtimeSource = normalizeServerAiSource(await getSetting(SERVER_AI_SOURCE_KEY, 'managed'))
  return runtimeSource
}

export function getRuntimeServerAiSource(): ServerAiSource {
  return runtimeSource
}

export function setRuntimeServerAiSource(value: ServerAiSource): void {
  runtimeSource = value
}
