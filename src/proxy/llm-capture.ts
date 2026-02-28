import http from 'node:http'
import { URL } from 'node:url'
import { Readable } from 'node:stream'
import type { LLMStep } from '../trace-adapter/context.js'

const DEFAULT_PORT = 8787
const HEADER_TRACE_ID = 'x-trace-id'

type Provider = 'openai' | 'gemini' | 'grok' | 'anthropic'

const DEFAULT_UPSTREAM: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  grok: 'https://api.x.ai',
  anthropic: 'https://api.anthropic.com',
}

const AI_PATTERNS: Record<Provider, RegExp> = {
  openai: /\/v1\/(chat\/)?completions/, // also covers legacy /v1/completions
  gemini: /\/v1beta\/models\/[^/:]+:(generateContent|streamGenerateContent)/,
  grok: /\/v1\/(chat\/)?completions/,
  anthropic: /\/v1\/messages/,
}

function detectProvider(pathname: string): Provider | null {
  for (const [provider, pattern] of Object.entries(AI_PATTERNS) as Array<[Provider, RegExp]>) {
    if (pattern.test(pathname)) return provider
  }
  return null
}

function extractModel(provider: Provider, body: Record<string, unknown>, url: string): string {
  if (provider === 'gemini') {
    const match = /\/models\/([^/:]+):/.exec(url)
    return match ? match[1] : 'unknown'
  }
  if (provider === 'anthropic') {
    return typeof body.model === 'string' ? body.model : 'unknown'
  }
  return typeof body.model === 'string' ? body.model : 'unknown'
}

function extractPrompt(provider: Provider, body: Record<string, unknown>): string {
  if (provider === 'openai' || provider === 'grok') {
    const messages = body.messages
    if (Array.isArray(messages)) {
      return messages
        .map((m: unknown) => {
          if (m && typeof m === 'object') {
            const msg = m as Record<string, unknown>
            return `${msg.role}: ${msg.content}`
          }
          return String(m)
        })
        .join('\n')
    }
    return typeof body.prompt === 'string' ? body.prompt : ''
  }

  if (provider === 'gemini') {
    const contents = body.contents
    if (Array.isArray(contents)) {
      return contents
        .flatMap((c: unknown) => {
          if (c && typeof c === 'object') {
            const parts = (c as Record<string, unknown>).parts
            if (Array.isArray(parts)) {
              return parts.map((p: unknown) => {
                if (p && typeof p === 'object') {
                  return String((p as Record<string, unknown>).text ?? '')
                }
                return ''
              })
            }
          }
          return []
        })
        .join('\n')
    }
  }

  if (provider === 'anthropic') {
    const messages = body.messages
    if (Array.isArray(messages)) {
      return messages
        .map((m: unknown) => {
          if (m && typeof m === 'object') {
            const msg = m as Record<string, unknown>
            return `${msg.role ?? 'user'}: ${msg.content ?? ''}`
          }
          return String(m)
        })
        .join('\n')
    }
  }

  return ''
}

function extractCompletion(provider: Provider, responseBody: Record<string, unknown>): string {
  if (provider === 'openai' || provider === 'grok') {
    const choices = responseBody.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>
      if (first.message && typeof first.message === 'object') {
        return String((first.message as Record<string, unknown>).content ?? '')
      }
      if (typeof first.text === 'string') return first.text
    }
  }

  if (provider === 'gemini') {
    const candidates = responseBody.candidates
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0] as Record<string, unknown>
      if (first.content && typeof first.content === 'object') {
        const parts = (first.content as Record<string, unknown>).parts
        if (Array.isArray(parts) && parts.length > 0) {
          return String((parts[0] as Record<string, unknown>).text ?? '')
        }
      }
    }
  }

  if (provider === 'anthropic') {
    const content = responseBody.content
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>
      if (typeof first.text === 'string') return first.text
      if (first.type === 'text' && typeof first.text === 'string') return first.text
    }
  }

  return ''
}

function cloneHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[key] = value.join(', ')
    } else if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}

function normalizeUpstream(provider: Provider, userBase?: string): string {
  const base = userBase || DEFAULT_UPSTREAM[provider]
  return base.endsWith('/') ? base.slice(0, -1) : base
}

type Store = Map<string, LLMStep[]>

function recordStep(store: Store, traceId: string, step: LLMStep): void {
  if (!store.has(traceId)) {
    store.set(traceId, [])
  }
  store.get(traceId)!.push(step)
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function sendUpstreamResponse(upstreamRes: Response, res: http.ServerResponse): void {
  res.statusCode = upstreamRes.status
  for (const [key, value] of upstreamRes.headers.entries()) {
    res.setHeader(key, value)
  }
  const body = upstreamRes.body
  if (!body) {
    res.end()
    return
  }
  const nodeStream = Readable.fromWeb(body as unknown as ReadableStream)
  nodeStream.pipe(res)
}

export interface StartedProxy {
  url: string
  stop(): Promise<void>
}

export interface ProxyOptions {
  port?: number
  upstream?: Partial<Record<Provider, string>>
}

export async function startLLMProxy(options: ProxyOptions = {}): Promise<StartedProxy> {
  const port = options.port ?? DEFAULT_PORT
  const store: Store = new Map()
  const upstreamOverride = options.upstream || {}

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        res.statusCode = 400
        res.end('Bad request')
        return
      }

      const parsed = new URL(req.url, `http://localhost:${port}`)

      if (req.method === 'GET' && parsed.pathname.startsWith('/traces/')) {
        const traceId = decodeURIComponent(parsed.pathname.replace('/traces/', ''))
        const steps = store.get(traceId) ?? []
        store.delete(traceId)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ steps }))
        return
      }

      if (req.method === 'GET' && parsed.pathname === '/health') {
        res.statusCode = 200
        res.end('ok')
        return
      }

      const bodyBuf = await readBody(req)
      const bodyText = bodyBuf.toString() || '{}'
      const requestBody = (() => {
        try {
          return JSON.parse(bodyText) as Record<string, unknown>
        } catch {
          return {} as Record<string, unknown>
        }
      })()

      const provider = detectProvider(parsed.pathname)
      const traceId = (req.headers[HEADER_TRACE_ID] as string | undefined)?.toString()
      const isStreaming = requestBody && typeof requestBody === 'object' ? (requestBody as any).stream === true : false
      const headers = cloneHeaders(req.headers)

      const upstreamBase = provider ? normalizeUpstream(provider, upstreamOverride[provider]) : undefined
      if (!provider || !upstreamBase) {
        // Fallback passthrough without capture
        const passthrough = await fetch(parsed.toString(), {
          method: req.method,
          headers,
          body: bodyBuf.length > 0 ? bodyBuf : undefined,
        })
        sendUpstreamResponse(passthrough, res)
        return
      }

      const targetUrl = `${upstreamBase}${parsed.pathname}${parsed.search}`
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: bodyBuf.length > 0 ? bodyBuf : undefined,
      })

      if (traceId) {
        const model = extractModel(provider, requestBody, targetUrl)
        const prompt = extractPrompt(provider, requestBody)
        if (isStreaming) {
          recordStep(store, traceId, { model, provider, prompt, completion: '(streamed)' })
        } else {
          try {
            const clone = upstreamRes.clone()
            const responseBody = (await clone.json()) as Record<string, unknown>
            const completion = extractCompletion(provider, responseBody)
            recordStep(store, traceId, { model, provider, prompt, completion })
          } catch {
            recordStep(store, traceId, { model, provider, prompt, completion: '' })
          }
        }
      }

      sendUpstreamResponse(upstreamRes, res)
    } catch (err) {
      res.statusCode = 500
      res.end(`proxy error: ${(err as Error).message}`)
    }
  })

  await new Promise<void>((resolve) => server.listen(port, resolve))

  return {
    url: `http://localhost:${port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function fetchCapturedTrace(proxyUrl: string, traceId: string): Promise<LLMStep[]> {
  const url = `${proxyUrl.replace(/\/$/, '')}/traces/${encodeURIComponent(traceId)}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`failed to fetch trace ${traceId} from proxy: ${res.status}`)
  }
  const data = (await res.json()) as { steps?: LLMStep[] }
  return data.steps || []
}
