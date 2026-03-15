# Tool Recording and Replay

ElasticDash automatically records and traces tool calls during workflow execution, providing replay and debugging capabilities.

For HTTP response streaming capture (SSE/NDJSON fetch flows), see `README.md` and `docs/quickstart.md#capture-streaming-flows`. That behavior is handled by the HTTP interceptor and is separate from manual tool instrumentation in this document.

## Manual Tool Recording

For tools outside the normal import flow, or if you need explicit success/error logging control, use a resilient `recordToolCall` pattern where tracing is isolated from the main service path:

```ts
import { runSelectQuery } from 'path/to/tool/calls'

export const dataService = async (input: any) => {
  const { query } = input as { query: string }

  return await runSelectQuery(query)
    .then(async (result: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('dataService', input, result)
      } catch {
        // trace logging errors must not break the main service
      }
      return result
    })
    .catch(async (error: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('dataService', input, error)
      } catch {
        // trace logging errors must not break the main service
      }
      throw error
    })
}
```

Why this pattern is recommended for manual instrumentation:

- Build-time or mainstream runtime contexts may not have tracing APIs available.
- Dynamic import plus nested `try/catch` keeps `recordToolCall` best-effort.
- Service success/failure behavior is preserved even when trace logging fails.

If your runtime may execute outside ElasticDash worker context, dynamic import keeps behavior safe:

```ts
try {
  const { recordToolCall } = await import('elasticdash-test')
  recordToolCall('dataService', input, result)
} catch {
  // no-op outside elasticdash runtime
}
```

**Note:** Manual recording is best-effort trace logging. Keep the same resilient pattern (dynamic import + nested `try/catch`) across all tools so trace logging never interrupts core service execution.

## Calling Tools from Workflows

**Always call tool functions from `ed_tools.ts` (or `ed_tools.js`), not from their source code locations.**

In your workflows, import and use tools through the instrumented export:

```ts
// ✅ Correct - calls the traced version from ed_tools.ts
import { dataService } from './ed_tools'

export const checkoutWorkflow = async (orderId: string) => {
  const orderData = await dataService({ query: `SELECT * FROM orders WHERE id = ${orderId}` })
  // ... rest of workflow
}
```

Not directly from the source file:
```ts
// ❌ Wrong - bypasses tracing instrumentation
import { runSelectQuery } from './services/dataService'

export const checkoutWorkflow = async (orderId: string) => {
  const orderData = await runSelectQuery(`SELECT * FROM orders WHERE id = ${orderId}`)
  // ... rest of workflow
}
```

**Why this matters:**
- Tool calls through `ed_tools.ts` are automatically traced and recorded
- Direct imports bypass the `recordToolCall` instrumentation
- Dashboard trace replay requires tools to be called through `ed_tools.ts`
- LLM agents calling tools will record the call with the `name` from `ed_tools.ts`, so using the same import ensures name matching

## Tool Function Compatibility (`ed_tools.ts/js`)

Exports in `ed_tools.ts/js` should be plain callable functions that take serializable input and return serializable output.

- Export directly callable functions
- Use JSON-serializable args/results (object, array, string, number, boolean, or `null`)
- Avoid exporting framework request/response handlers directly (for example Next.js `NextRequest`/`NextResponse` route handlers)

Compatible export example:

```ts
export async function chargeCard(input: { amount: number; token: string }) {
  return { success: true, transactionId: 'txn-123' }
}
```

Not directly compatible as a tool export:

```ts
// Next.js route handler style
export async function POST(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ ok: true })
}
```

If your app uses framework handlers, keep `ed_tools.ts/js` as a plain callable boundary and invoke your framework-specific code behind that boundary.

## Recording Without Passing `ctx.trace`

Use Node's `AsyncLocalStorage` to record steps without threading `ctx.trace` through every function:

```ts
// In your test
import { setCurrentTrace } from 'elasticdash-test'

aiTest('flow test', async (ctx) => {
  setCurrentTrace(ctx.trace)          // bind the trace to the current async context
  await runFlowWithoutTraceArg()      // your existing code
  expect(ctx.trace).toHaveCustomStep({ kind: 'rag', name: 'pokemon-search' })
})

// In your app/flow code (called during the test)
import { getCurrentTrace } from 'elasticdash-test'

function runFlowWithoutTraceArg() {
  const trace = getCurrentTrace()
  trace?.recordCustomStep({
    kind: 'rag',
    name: 'pokemon-search',
    payload: { query: 'pikachu attack' },
    result: { ids: [25] },
    tags: ['source:db', 'sort:asc'],
  })
}
```

**Notes:**
- Works per async context; if you spawn detached work (child processes/independent workers), pass `trace` explicitly there.
- Still compatible with manual DI: you can continue passing `ctx.trace` explicitly if you prefer.

## Optional LLM Capture Proxy (for Supabase Edge / Deno)

For environments where Node fetch interception doesn't work (like Supabase Edge Functions or Deno Deploy):

1. Set `ELASTICDASH_LLM_PROXY=1` (optional: `ELASTICDASH_LLM_PROXY_PORT`, default `8787`)
2. The runner starts a local proxy and generates a per-test `ELASTICDASH_TRACE_ID`
3. Point your LLM client at the proxy via base URL envs:
   ```bash
   OPENAI_BASE_URL=http://localhost:8787/v1
   ANTHROPIC_API_URL=http://localhost:8787
   ```
4. Forward the trace ID to your Edge/Deno code (e.g., add `x-trace-id: process.env.ELASTICDASH_TRACE_ID` header)
5. The proxy records model/prompt/completion and folds captured steps back into `ctx.trace`

When `ELASTICDASH_LLM_PROXY` is unset, the existing Node fetch interceptor remains the default.
