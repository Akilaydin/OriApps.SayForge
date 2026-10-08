
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /apikey/i,
  /access[_-]?token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /app[_-]?id/i,
]

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

export function maskValue(value: unknown): string {
  const str = String(value ?? '')
  if (str.length <= 8) return '***'
  return `${str.slice(0, 3)}***${str.slice(-2)}`
}

export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key) && typeof value === 'string' && value.length > 0) {
      result[key] = maskValue(value)
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeObject(value)
    } else {
      result[key] = value
    }
  }
  return result as T
}
