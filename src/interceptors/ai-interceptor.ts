import { getCurrentTrace } from '../trace-adapter/context.js'
import { getCaptureContext } from '../capture/recorder.js'

/** URL patterns for known AI providers */
const AI_PATTERNS: Record<string, RegExp> = {
  openai: /https?:\/\/api\.openai\.com\/v1\/((chat\/)?completions|embeddings)/,
  gemini: /https?:\/\/generativelanguage\.googleapis\.com\/.*\/models\/[^/:]+:(generateContent|streamGenerateContent)/,
  grok:   /https?:\/\/api\.x\.ai\/v1\/(chat\/)?completions/,
  kimi:   /https?:\/\/api\.moonshot\.ai\/v1\/(chat\/)?completions/,
}

/** Detect which provider (if any) a URL belongs to */
function detectProvider(url: string): string | null {
  for (const [provider, pattern] of Object.entries(AI_PATTERNS)) {
    if (pattern.test(url)) return provider
  }
  return null
}

/** Extract model name from request body or URL (for Gemini) */
function extractModel(provider: string, body: Record<string, unknown>, url: string): string {
  if (provider === 'gemini') {
    // URL shape: .../models/gemini-1.5-pro:generateContent
    const match = /\/models\/([^/:]+):/.exec(url)
    return match ? match[1] : 'unknown'
  }
  return typeof body.model === 'string' ? body.model : 'unknown'
}

/** Extract prompt text from request body */
function extractPrompt(provider: string, body: Record<string, unknown>): string {
  if (provider === 'openai' || provider === 'grok' || provider === 'kimi') {
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
    // Legacy completions API
    if (typeof body.prompt === 'string') return body.prompt
    if (typeof body.input === 'string') return body.input
    if (Array.isArray(body.input)) return body.input.map((v) => String(v)).join('\n')
    return ''
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

  return ''
}

/** Extract completion text from response body */
function extractCompletion(provider: string, responseBody: Record<string, unknown>): string {
  if (provider === 'openai' || provider === 'grok' || provider === 'kimi') {
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

  return ''
}

// Keep a reference to the original fetch so we can restore it
let originalFetch: typeof globalThis.fetch | null = null

/**
 * Install the AI fetch interceptor. Wraps globalThis.fetch to automatically
 * record LLM steps into the active trace for OpenAI, Gemini, and Grok calls.
 */
export function installAIInterceptor(): void {
  if (originalFetch) return // already installed

  originalFetch = globalThis.fetch

  globalThis.fetch = async function patchedFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url

    const provider = detectProvider(url)
    const traceAtCall = getCurrentTrace()

    // No match or no active trace: pass through unchanged
    if (!provider || !traceAtCall) {
      return originalFetch!(input, init)
    }

    // Parse request body to extract model and prompt
    let model = 'unknown'
    let prompt = ''
    let isStreaming = false

    try {
      const rawBody = init?.body
      if (rawBody && typeof rawBody === 'string') {
        const body = JSON.parse(rawBody) as Record<string, unknown>
        model = extractModel(provider, body, url)
        prompt = extractPrompt(provider, body)
        isStreaming = body.stream === true
      }
    } catch {
      // Ignore parse errors — still pass through
    }

    const ctx = getCaptureContext()

    if (ctx) {
      const { recorder, replay } = ctx
      const id = recorder.nextId()
      const start = Date.now()

      // Replay mode: return the historical response without making a real call
      if (replay.shouldReplay(id)) {
        const historicalEvent = replay.getRecordedEvent(id)
        const historicalInput = historicalEvent?.input as Record<string, unknown> | undefined
        const historicalUrl = typeof historicalInput?.url === 'string' ? historicalInput.url : undefined
        const historicalProvider = typeof historicalInput?.provider === 'string' ? historicalInput.provider : undefined
        const isReplayMatch = !!historicalEvent
          && historicalEvent.type === 'ai'
          && historicalProvider === provider
          && historicalUrl === url

        if (isReplayMatch && historicalEvent) {
          recorder.record(historicalEvent)
          const historicalOutput = historicalEvent.output as Record<string, unknown> | null
          const completion = historicalOutput ? extractCompletion(provider, historicalOutput) : '(replayed)'
          traceAtCall.recordLLMStep({ model, provider, prompt, completion })
          return new Response(
            historicalOutput != null ? JSON.stringify(historicalOutput) : null,
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // No historical event found — fall through to fresh execution
      }

      // Fresh execution: make the real call and record to both systems
      const response = await originalFetch!(input, init)
      const durationMs = Date.now() - start

      if (isStreaming) {
        traceAtCall.recordLLMStep({ model, provider, prompt, completion: '(streamed)' })
        recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: null, timestamp: start, durationMs })
      } else {
        try {
          const cloned = response.clone()
          const responseBody = await cloned.json() as Record<string, unknown>
          const completion = extractCompletion(provider, responseBody)
          traceAtCall.recordLLMStep({ model, provider, prompt, completion })
          recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: responseBody, timestamp: start, durationMs })
        } catch {
          traceAtCall.recordLLMStep({ model, provider, prompt, completion: '' })
          recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: null, timestamp: start, durationMs })
        }
      }

      return response
    }

    // No capture context — original behaviour (outside of a workflow run)
    const response = await originalFetch!(input, init)

    if (isStreaming) {
      traceAtCall.recordLLMStep({ model, provider, prompt, completion: '(streamed)' })
    } else {
      try {
        const cloned = response.clone()
        const responseBody = await cloned.json() as Record<string, unknown>
        const completion = extractCompletion(provider, responseBody)
        traceAtCall.recordLLMStep({ model, provider, prompt, completion })
      } catch {
        traceAtCall.recordLLMStep({ model, provider, prompt, completion: '' })
      }
    }

    return response
  }
}

/**
 * Uninstall the AI fetch interceptor, restoring globalThis.fetch to its original value.
 */
export function uninstallAIInterceptor(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = null
  }
}
