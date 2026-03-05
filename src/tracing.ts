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

export function recordToolCall(name: string, args: any, result: any) {
  // Use AsyncLocalStorage-backed runner context (parallel-safe)
  const trace = getCurrentTrace()
  if (trace && typeof trace.recordToolCall === 'function') {
    try {
      trace.recordToolCall({ name, args, result })
      console.log(`[ElasticDash] recordToolCall: ${name} with args ${JSON.stringify(args)} and result ${JSON.stringify(result)}`)
    } catch (e) {
      console.error('Error recording tool call:', e)
      // Never throw, always swallow errors
    }
  } else {
    console.log(`[ElasticDash] recordToolCall called outside of ElasticDash runner. Tool: ${name}, args: ${JSON.stringify(args)}, result: ${JSON.stringify(result)}`)
  }
  // No-op if not running in ElasticDash
}
