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
export function recordToolCall(name: string, args: any, result: any) {
  // ElasticDash runner will inject a global trace context
  const trace = (globalThis as any).__elasticdash_trace
  if (trace && typeof trace.recordToolCall === 'function') {
    try {
      trace.recordToolCall({ name, args, result })
    } catch (e) {
      // Never throw, always swallow errors
    }
  }
  // No-op if not running in ElasticDash
}
