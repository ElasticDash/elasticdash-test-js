import { getCaptureContext } from '../capture/recorder.js'
import { getCurrentTrace } from '../trace-adapter/context.js'
import { rawDateNow } from './side-effects.js'

const TOOL_WRAPPER_ACTIVE_KEY = '__elasticdash_tool_wrapper_active__'

function toTraceArgs(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (input === undefined) return undefined
  return { value: input }
}

function isReadableStream(v: unknown): v is ReadableStream<Uint8Array> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ReadableStream).getReader === 'function' &&
    typeof (v as ReadableStream).tee === 'function'
  )
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === 'object' && v !== null && Symbol.asyncIterator in (v as object)
}

async function bufferReadableStream(stream: ReadableStream<Uint8Array>): Promise<string> {
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
  return raw
}

function reconstructStream(raw: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(raw))
      ctrl.close()
    },
  })
}

/** Wraps an AsyncIterable so chunks are collected while the caller iterates */
function wrapAsyncIterable<T>(
  source: AsyncIterable<T>,
  onComplete: (chunks: T[]) => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iter = source[Symbol.asyncIterator]()
      const collected: T[] = []
      return {
        async next() {
          const result = await iter.next()
          if (!result.done) {
            collected.push(result.value)
          } else {
            onComplete(collected)
          }
          return result
        },
        async return(value?: unknown) {
          onComplete(collected)
          return iter.return ? iter.return(value) : { done: true as const, value: undefined }
        },
      }
    },
  }
}

export function wrapTool<Args extends unknown[], R>(
  name: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const ctx = getCaptureContext()
    if (!ctx) return fn(...args)

    const trace = getCurrentTrace()
    const { recorder, replay } = ctx
    const id = recorder.nextId()
    const input = args.length === 1 ? args[0] : args

    if (replay.shouldReplay(id)) {
      const historical = replay.getRecordedEvent(id)
      if (historical) recorder.record(historical)

      if (historical?.streamed === true) {
        const raw = typeof historical.streamRaw === 'string' ? historical.streamRaw : ''
        const stream = reconstructStream(raw) as unknown as R
        if (trace && typeof trace.recordToolCall === 'function') {
          trace.recordToolCall({ name, args: toTraceArgs(input), result: stream, workflowEventId: id })
        }
        return stream
      }

      const replayed = replay.getRecordedResult(id) as R
      if (trace && typeof trace.recordToolCall === 'function') {
        trace.recordToolCall({ name, args: toTraceArgs(input), result: replayed, workflowEventId: id })
      }
      return replayed
    }

    const g = globalThis as Record<string, unknown>
    const prev = g[TOOL_WRAPPER_ACTIVE_KEY]
    g[TOOL_WRAPPER_ACTIVE_KEY] = true
    const start = rawDateNow()

    try {
      const output = await fn(...args)

      if (isReadableStream(output)) {
        const [streamForCaller, streamForRecorder] = output.tee()
        bufferReadableStream(streamForRecorder).then((rawText) => {
          recorder.record({ id, type: 'tool', name, input, output: null, streamed: true, streamRaw: rawText, timestamp: start, durationMs: rawDateNow() - start })
        }).catch(() => {
          recorder.record({ id, type: 'tool', name, input, output: null, streamed: true, streamRaw: '', timestamp: start, durationMs: rawDateNow() - start })
        })
        const result = streamForCaller as unknown as R
        if (trace && typeof trace.recordToolCall === 'function') {
          trace.recordToolCall({ name, args: toTraceArgs(input), result, workflowEventId: id })
        }
        return result
      }

      if (isAsyncIterable(output)) {
        const wrapped = wrapAsyncIterable(output, (chunks) => {
          const rawText = chunks.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('')
          recorder.record({ id, type: 'tool', name, input, output: null, streamed: true, streamRaw: rawText, timestamp: start, durationMs: rawDateNow() - start })
        }) as unknown as R
        if (trace && typeof trace.recordToolCall === 'function') {
          trace.recordToolCall({ name, args: toTraceArgs(input), result: wrapped, workflowEventId: id })
        }
        return wrapped
      }

      recorder.record({
        id,
        type: 'tool',
        name,
        input,
        output,
        timestamp: start,
        durationMs: rawDateNow() - start,
      })
      if (trace && typeof trace.recordToolCall === 'function') {
        trace.recordToolCall({ name, args: toTraceArgs(input), result: output, workflowEventId: id })
      }
      return output
    } catch (e) {
      recorder.record({
        id,
        type: 'tool',
        name,
        input,
        output: { error: String(e) },
        timestamp: start,
        durationMs: rawDateNow() - start,
      })
      if (trace && typeof trace.recordToolCall === 'function') {
        trace.recordToolCall({ name, args: toTraceArgs(input), result: { error: String(e) }, workflowEventId: id })
      }
      throw e
    } finally {
      if (prev === undefined) delete g[TOOL_WRAPPER_ACTIVE_KEY]
      else g[TOOL_WRAPPER_ACTIVE_KEY] = prev
    }
  }
}
