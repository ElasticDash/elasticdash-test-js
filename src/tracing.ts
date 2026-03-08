// src/tracing.ts
// ElasticDash tool call recording utility

/**
 * Records a tool call for workflow tracing. Safe to call in any environment.
 * If not running inside the ElasticDash runner, this is a no-op.
 *
 * @param name - The tool name
 * @param args - The tool arguments (object or array)
 * @param result - The tool result (or error)
 */
import { getCurrentTrace } from './trace-adapter/context.js'
import { getCaptureContext } from './capture/recorder.js'
import { rawDateNow } from './interceptors/side-effects.js'

const TOOL_WRAPPER_ACTIVE_KEY = '__elasticdash_tool_wrapper_active__'

function wrapperRecordingActive(): boolean {
  return (globalThis as Record<string, unknown>)[TOOL_WRAPPER_ACTIVE_KEY] === true
}

export function recordToolCall(name: string, args: any, result: any) {
  if (!(globalThis as any).__ELASTICDASH_WORKER__) return
  try {
    // Avoid double-recording when a replay-aware tool wrapper is already active.
    if (wrapperRecordingActive()) return

    const trace = getCurrentTrace()
    if (!trace || typeof trace.recordToolCall !== 'function') return

    const ctx = getCaptureContext()
    if (!ctx) {
      trace.recordToolCall({ name, args, result })
      return
    }

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      const historical = replay.getRecordedEvent(id)
      if (historical) recorder.record(historical)
      const replayed = replay.getRecordedResult(id)
      trace.recordToolCall({ name, args, result: replayed, workflowEventId: id })
      return
    }

    const output = result instanceof Error ? { error: String(result) } : result
    recorder.record({
      id,
      type: 'tool',
      name,
      input: args,
      output,
      timestamp: rawDateNow(),
      durationMs: 0,
    })
    trace.recordToolCall({ name, args, result: output, workflowEventId: id })
  } catch {
    // Never throw, always swallow errors
  }
}
