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
