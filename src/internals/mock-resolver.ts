/**
 * Runtime tool mock resolution for module-imported tools.
 *
 * Tools that are statically imported (not accessed via globalThis) cannot be
 * intercepted by the worker's proxy-based mocking. Instead, each tool function
 * calls `resolveMock` at its entry point. The worker writes the mock config to
 * `__ELASTICDASH_TOOL_MOCKS__` before the workflow runs and clears it after.
 */

interface ToolMockEntry {
  mode: 'live' | 'mock-all' | 'mock-specific'
  callIndices?: number[]
  mockData?: Record<number, unknown>
}

type MockResult =
  | { mocked: true; result: unknown }
  | { mocked: false }

/**
 * Recursively normalises a mock result fetched from the trace.
 *
 * The trace recorder stores tool outputs as-is. When a tool returns a JSON
 * string (rather than a parsed object), the stored value is that string, and
 * inner string values may themselves be JSON-quoted. This function unwraps
 * every layer so the calling code receives the same shape as the real output.
 *
 * - string  → try JSON.parse, then recurse on the result
 * - array   → recurse on every element
 * - object  → recurse on every value
 * - other   → return unchanged
 */
function normaliseMockResult(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return normaliseMockResult(JSON.parse(value)) } catch { return value }
  }
  if (Array.isArray(value)) {
    return value.map(normaliseMockResult)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normaliseMockResult(v)
    }
    return out
  }
  return value
}

/**
 * Resolves whether the current call to `toolName` should be mocked.
 *
 * - Returns `{ mocked: false }` when no mock config is active or mode is `'live'`.
 * - Increments the per-tool call counter on every non-live invocation so that
 *   `mock-specific` indices remain accurate even when some calls run live.
 * - Safe to call in production: no-op when the mock globals are absent.
 */
export function resolveMock(toolName: string): MockResult {
  const g = globalThis as Record<string, unknown>

  const mocks = g['__ELASTICDASH_TOOL_MOCKS__'] as Record<string, ToolMockEntry> | undefined
  if (!mocks) return { mocked: false }

  const entry = mocks[toolName]
  if (!entry || entry.mode === 'live') return { mocked: false }

  // Initialise counters map if not yet present
  if (!g['__ELASTICDASH_TOOL_CALL_COUNTERS__']) {
    g['__ELASTICDASH_TOOL_CALL_COUNTERS__'] = {} as Record<string, number>
  }
  const counters = g['__ELASTICDASH_TOOL_CALL_COUNTERS__'] as Record<string, number>
  counters[toolName] = (counters[toolName] ?? 0) + 1
  const callNumber = counters[toolName]

  if (entry.mode === 'mock-all') {
    const data = entry.mockData ?? {}
    const raw = data[callNumber] !== undefined ? data[callNumber] : data[0]
    return { mocked: true, result: normaliseMockResult(raw) }
  }

  if (entry.mode === 'mock-specific') {
    const indices = entry.callIndices ?? []
    if (indices.includes(callNumber)) {
      const data = entry.mockData ?? {}
      return { mocked: true, result: normaliseMockResult(data[callNumber]) }
    }
    // Counter already incremented; this specific call runs live
    return { mocked: false }
  }

  return { mocked: false }
}
