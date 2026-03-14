import { getCurrentTrace } from '../trace-adapter/context.js'
import { getCaptureContext } from '../capture/recorder.js'
import { rawDateNow } from './side-effects.js'

/** URL patterns for known AI providers */
const AI_PATTERNS: Record<string, RegExp> = {
  openai:    /https?:\/\/api\.openai\.com\/v1\/((chat\/)?completions|embeddings)/,
  anthropic: /https?:\/\/api\.anthropic\.com\/v1\/messages/,
  gemini:    /https?:\/\/generativelanguage\.googleapis\.com\/.*\/models\/[^\/:]+:(generateContent|streamGenerateContent)/,
  grok:      /https?:\/\/api\.x\.ai\/v1\/(chat\/)?completions/,
  kimi:      /https?:\/\/api\.moonshot\.ai\/v1\/(chat\/)?completions/,
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
  if (provider === 'openai' || provider === 'anthropic' || provider === 'grok' || provider === 'kimi') {
    let systemPrefix = ''
    // Anthropic supports a top-level `system` parameter
    if (provider === 'anthropic') {
      if (typeof body.system === 'string') {
        systemPrefix = `system: ${body.system}\n`
      } else if (Array.isArray(body.system)) {
        systemPrefix = body.system
          .map((b: unknown) => {
            if (b && typeof b === 'object') {
              return String((b as Record<string, unknown>).text ?? '')
            }
            return String(b)
          })
          .filter(Boolean)
          .map((t) => `system: ${t}`)
          .join('\n') + '\n'
      }
    }
    const messages = body.messages
    if (Array.isArray(messages)) {
      const msgText = messages
        .map((m: unknown) => {
          if (m && typeof m === 'object') {
            const msg = m as Record<string, unknown>
            // Anthropic content can be a string or an array of content blocks
            let content = msg.content
            if (Array.isArray(content)) {
              content = content
                .map((b: unknown) => {
                  if (b && typeof b === 'object') {
                    return String((b as Record<string, unknown>).text ?? '')
                  }
                  return String(b)
                })
                .filter(Boolean)
                .join('')
            }
            return `${msg.role}: ${content}`
          }
          return String(m)
        })
        .join('\n')
      return systemPrefix + msgText
    }
    // Legacy completions API (OpenAI)
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
  // Handle buffered streaming format
  if (responseBody.streamed === true && typeof responseBody.completion === 'string') {
    return responseBody.completion
  }

  if (provider === 'openai' || provider === 'grok' || provider === 'kimi') {
    const choices = responseBody.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>
      if (first.message && typeof first.message === 'object') {
        return String((first.message as Record<string, unknown>).content ?? '')
      }
      if (typeof first.text === 'string') return first.text
    }
    // Embedding response: data[].embedding
    const data = responseBody.data
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as Record<string, unknown>
      if (Array.isArray(first?.embedding)) {
        return `[${data.length} embedding(s), ${first.embedding.length} dimensions]`
      }
    }
  }

  if (provider === 'anthropic') {
    const content = responseBody.content
    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>
            if (b.type === 'text' && typeof b.text === 'string') return b.text
          }
          return ''
        })
        .filter(Boolean)
        .join('')
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
    // Gemini embedding response: embeddings[].values
    const embeddings = responseBody.embeddings
    if (Array.isArray(embeddings) && embeddings.length > 0) {
      const first = embeddings[0] as Record<string, unknown>
      if (Array.isArray(first?.values)) {
        return `[${embeddings.length} embedding(s), ${first.values.length} dimensions]`
      }
    }
  }

  return ''
}

/** Buffer a streaming SSE/NDJSON response to extract the completion text */
async function bufferSSEStream(
  provider: string,
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let raw = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }

  const lines = raw.split('\n')
  let completion = ''

  if (provider === 'gemini') {
    // NDJSON: lines may be wrapped in `[` / `]` / `,`
    for (const line of lines) {
      const trimmed = line.trim().replace(/^[,\[]/, '').replace(/[,\]]$/, '')
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        const candidates = obj.candidates
        if (Array.isArray(candidates) && candidates.length > 0) {
          const first = candidates[0] as Record<string, unknown>
          if (first.content && typeof first.content === 'object') {
            const parts = (first.content as Record<string, unknown>).parts
            if (Array.isArray(parts) && parts.length > 0) {
              completion += String((parts[0] as Record<string, unknown>).text ?? '')
            }
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  } else if (provider === 'anthropic') {
    // Anthropic SSE format: event: <type>\ndata: <json>
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      try {
        const obj = JSON.parse(data) as Record<string, unknown>
        if (obj.type === 'content_block_delta') {
          const delta = obj.delta as Record<string, unknown> | undefined
          if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
            completion += delta.text
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  } else {
    // OpenAI / Grok / Kimi SSE format
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const obj = JSON.parse(data) as Record<string, unknown>
        const choices = obj.choices
        if (Array.isArray(choices) && choices.length > 0) {
          const first = choices[0] as Record<string, unknown>
          if (first.delta && typeof first.delta === 'object') {
            completion += String((first.delta as Record<string, unknown>).content ?? '')
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  return completion
}

/** Build a minimal non-streaming JSON response body from a completion string (for replay) */
function synthesizeCompletionJSON(
  provider: string,
  completion: string,
): Record<string, unknown> {
  if (provider === 'gemini') {
    return {
      candidates: [{ content: { parts: [{ text: completion }], role: 'model' }, finishReason: 'STOP' }],
    }
  }
  if (provider === 'anthropic') {
    return {
      id: 'replay',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: completion }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    }
  }
  // OpenAI / Grok / Kimi format
  return {
    id: 'replay',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: completion }, finish_reason: 'stop' }],
  }
}

/** Build a minimal SSE/NDJSON ReadableStream from a completion string (for replay) */
function synthesizeSSEStream(
  provider: string,
  completion: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      if (provider === 'gemini') {
        const chunk = `[{"candidates":[{"content":{"parts":[{"text":${JSON.stringify(completion)}}],"role":"model"},"finishReason":"STOP"}]}]\n`
        ctrl.enqueue(encoder.encode(chunk))      } else if (provider === 'anthropic') {
        const msgStart = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'replay', type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null } })}\n\n`
        const blockStart = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`
        const delta = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: completion } })}\n\n`
        const blockStop = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
        const msgDelta = `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } })}\n\n`
        const msgStop = `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
        ctrl.enqueue(encoder.encode(msgStart))
        ctrl.enqueue(encoder.encode(blockStart))
        ctrl.enqueue(encoder.encode(delta))
        ctrl.enqueue(encoder.encode(blockStop))
        ctrl.enqueue(encoder.encode(msgDelta))
        ctrl.enqueue(encoder.encode(msgStop))      } else {
        const frame1 = `data: ${JSON.stringify({ id: 'replay', choices: [{ delta: { content: completion }, index: 0, finish_reason: null }] })}\n\n`
        const frame2 = 'data: [DONE]\n\n'
        ctrl.enqueue(encoder.encode(frame1))
        ctrl.enqueue(encoder.encode(frame2))
      }
      ctrl.close()
    },
  })
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
      const start = rawDateNow()

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
          traceAtCall.recordLLMStep({ model, provider, prompt, completion, workflowEventId: id })

          if (isStreaming) {
            // Current caller expects a streaming response — always synthesize SSE
            return new Response(synthesizeSSEStream(provider, completion), {
              status: 200,
              headers: { 'Content-Type': provider === 'gemini' ? 'application/json' : 'text/event-stream' },
            })
          }

          if (historicalOutput?.streamed === true) {
            // Original was streamed but caller now expects JSON — synthesize a completion response
            return new Response(JSON.stringify(synthesizeCompletionJSON(provider, completion)), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          return new Response(
            historicalOutput != null ? JSON.stringify(historicalOutput) : null,
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // No historical event found — fall through to fresh execution
      }

      // Fresh execution: make the real call and record to both systems
      const response = await originalFetch!(input, init)
      const durationMs = rawDateNow() - start

      if (isStreaming) {
        if (response.body) {
          const [streamForCaller, streamForRecorder] = response.body.tee()
          recorder.trackAsync(
            bufferSSEStream(provider, streamForRecorder).then((completion) => {
              const durationMs = rawDateNow() - start
              traceAtCall.recordLLMStep({ model, provider, prompt, completion, workflowEventId: id })
              recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: { streamed: true, completion }, timestamp: start, durationMs })
            }).catch(() => {
              traceAtCall.recordLLMStep({ model, provider, prompt, completion: '(streamed-error)', workflowEventId: id })
              recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: null, timestamp: start, durationMs: rawDateNow() - start })
            })
          )
          return new Response(streamForCaller, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } else {
          traceAtCall.recordLLMStep({ model, provider, prompt, completion: '(streamed)', workflowEventId: id })
          recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: null, timestamp: start, durationMs })
        }
      } else {
        try {
          const cloned = response.clone()
          const responseBody = await cloned.json() as Record<string, unknown>
          const completion = extractCompletion(provider, responseBody)
          traceAtCall.recordLLMStep({ model, provider, prompt, completion, workflowEventId: id })
          recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: responseBody, timestamp: start, durationMs })
        } catch {
          traceAtCall.recordLLMStep({ model, provider, prompt, completion: '', workflowEventId: id })
          recorder.record({ id, type: 'ai', name: model, input: { url, provider, model, prompt }, output: null, timestamp: start, durationMs })
        }
      }

      return response
    }

    // No capture context — original behaviour (outside of a workflow run)
    const response = await originalFetch!(input, init)

    if (isStreaming && response.body) {
      const [streamForCaller, streamForRecorder] = response.body.tee()
      bufferSSEStream(provider, streamForRecorder).then((completion) => {
        traceAtCall.recordLLMStep({ model, provider, prompt, completion })
      }).catch(() => {
        traceAtCall.recordLLMStep({ model, provider, prompt, completion: '(streamed-error)' })
      })
      return new Response(streamForCaller, { status: response.status, statusText: response.statusText, headers: response.headers })
    } else if (!isStreaming) {
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
