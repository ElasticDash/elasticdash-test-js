import { getCaptureContext } from '../capture/recorder.js'

// AI provider URLs are already captured by ai-interceptor.ts as "llm" steps.
// Skip them here to avoid duplicate observations.
const AI_URL_PATTERNS = [
  /https?:\/\/api\.openai\.com\/v1\/((chat\/)?completions|embeddings)/,
  /https?:\/\/generativelanguage\.googleapis\.com\/.*\/models\/[^/:]+:(generateContent|streamGenerateContent)/,
  /https?:\/\/api\.x\.ai\/v1\/(chat\/)?completions/,
  /https?:\/\/api\.moonshot\.ai\/v1\/(chat\/)?completions/,
]

function isAIProviderUrl(url: string): boolean {
  return AI_URL_PATTERNS.some(p => p.test(url))
}

function parseQuery(url: string): Record<string, string> | undefined {
  try {
    const { searchParams } = new URL(url)
    if (searchParams.size === 0) return undefined
    return Object.fromEntries(searchParams.entries())
  } catch {
    // Relative URL — extract manually
    const qIdx = url.indexOf('?')
    if (qIdx === -1) return undefined
    try {
      const params = new URLSearchParams(url.slice(qIdx + 1))
      if (![...params].length) return undefined
      return Object.fromEntries(params.entries())
    } catch {
      return undefined
    }
  }
}

function parseBody(body?: RequestInit['body'] | null): unknown {
  if (body == null) return undefined
  if (typeof body === 'string') {
    try { return JSON.parse(body) } catch { return body }
  }
  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries())
  }
  return '[binary]'
}

function normalizeHeaders(headers?: RequestInit['headers']): Record<string, string> | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) {
    const obj: Record<string, string> = {}
    headers.forEach((v, k) => { obj[k] = v })
    return obj
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers as Record<string, string>
}

function pickReplayResponseHeaders(headers?: Record<string, unknown>): Record<string, string> {
  if (!headers) return { 'Content-Type': 'application/json' }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value
  }
  if (!out['Content-Type']) out['Content-Type'] = 'application/json'
  return out
}

let originalFetch: typeof globalThis.fetch | undefined

export function interceptFetch(): void {
  if (originalFetch) return // already installed
  originalFetch = globalThis.fetch

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = getCaptureContext()
    if (!ctx) return originalFetch!(input, init)

    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const rawBody = init?.body ?? (input instanceof Request ? input.body : undefined)

    // Let ai-interceptor handle AI provider URLs — it assigns its own event IDs
    if (isAIProviderUrl(url)) {
      return originalFetch!(input, init)
    }

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      const historicalEvent = replay.getRecordedEvent(id)
      const historicalInput = historicalEvent?.input as Record<string, unknown> | undefined
      const historicalMethod = typeof historicalInput?.method === 'string' ? historicalInput.method.toUpperCase() : 'GET'
      const historicalUrl = typeof historicalInput?.url === 'string' ? historicalInput.url : undefined
      const isReplayMatch = !!historicalEvent
        && historicalEvent.type === 'http'
        && historicalEvent.name === 'fetch'
        && historicalMethod === method
        && historicalUrl === url

      if (isReplayMatch && historicalEvent) {
        recorder.record(historicalEvent)

        const replayMeta = (historicalInput?.__elasticdashResponse ?? {}) as Record<string, unknown>
        const replayStatus = typeof replayMeta.status === 'number' ? replayMeta.status : 200
        const replayStatusText = typeof replayMeta.statusText === 'string' ? replayMeta.statusText : ''
        const replayHeaders = pickReplayResponseHeaders(
          replayMeta.headers && typeof replayMeta.headers === 'object'
            ? (replayMeta.headers as Record<string, unknown>)
            : undefined,
        )

        const historicalOutput = replay.getRecordedResult(id)
        const body = historicalOutput != null ? JSON.stringify(historicalOutput) : null
        return new Response(body, {
          status: replayStatus,
          statusText: replayStatusText,
          headers: replayHeaders,
        })
      }
    }

    const query = parseQuery(url)
    const body = parseBody(rawBody as RequestInit['body'] | null | undefined)
    const headers = normalizeHeaders(rawHeaders)

    const start = Date.now()
    const res = await originalFetch!(input, init)

    let output: unknown = null
    try {
      output = await res.clone().json()
    } catch {
      // not JSON — record null
    }

    const responseHeadersObj: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      responseHeadersObj[k] = v
    })

    recorder.record({
      id,
      type: 'http',
      name: 'fetch',
      input: {
        url,
        method,
        ...(query ? { query } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        __elasticdashResponse: {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeadersObj,
          url: res.url,
        },
      },
      output,
      timestamp: start,
      durationMs: Date.now() - start,
    })

    return res
  }
}

export function restoreFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = undefined
  }
}
