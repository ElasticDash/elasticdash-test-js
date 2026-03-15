# Quick Start Guide

Get ElasticDash running in 10 minutes and start debugging your AI workflows.

## Table of Contents

- [Quick Start Guide](#quick-start-guide)
  - [Table of Contents](#table-of-contents)
  - [Section 1: Installation \& Configuration](#section-1-installation--configuration)
    - [Install the SDK](#install-the-sdk)
    - [Configure Environment Variables](#configure-environment-variables)
    - [Create `ed_workflows.ts`](#create-ed_workflowsts)
      - [Streaming Workflows](#streaming-workflows)
    - [Create `ed_tools.ts`](#create-ed_toolsts)
    - [Update Workflow Tool Calls](#update-workflow-tool-calls)
    - [Add Dashboard Script to `package.json`](#add-dashboard-script-to-packagejson)
  - [Section 2: Usage \& Example](#section-2-usage--example)
    - [End-to-End Example](#end-to-end-example)
    - [Open the Dashboard](#open-the-dashboard)
    - [Get Trace Data from Langfuse](#get-trace-data-from-langfuse)
    - [Debug with the Dashboard](#debug-with-the-dashboard)
    - [Capture Streaming Flows](#capture-streaming-flows)
    - [Next Steps](#next-steps)

---

## Section 1: Installation & Configuration

### Install the SDK

```bash
npm install elasticdash-test
```

Add `.temp/` to `.gitignore` — ElasticDash writes runtime artifacts there:

```gitignore
.temp/
```

### Configure Environment Variables

Set API keys for the LLM providers used in your workflows. Only set keys for providers you actually use.

```bash
# OpenAI
export OPENAI_API_KEY="sk-..."

# Claude (Anthropic)
export ANTHROPIC_API_KEY="sk-ant-..."

# Gemini (Google)
export GEMINI_API_KEY="AIzaSy..."
# or use GOOGLE_API_KEY instead

# Grok (xAI)
export GROK_API_KEY="xai-..."
```

Supported provider env var names are documented in `docs/matchers.md`.

### Create `ed_workflows.ts`

Create `ed_workflows.ts` (or `ed_workflows.js`) in your project root. Export all workflow functions you want to debug:

```ts
// ed_workflows.ts
export { checkoutFlow, refundFlow } from './src/workflows'
export { processOrderFlow } from './src/flows/orders'
```

**Requirements:** Each exported workflow must be a directly callable async function with JSON-serializable input/output.

Valid examples:

```ts
export async function checkoutFlow(input: { orderId: string }) {
  return { ok: true, orderId: input.orderId }
}

export async function batchFlow(input: Array<{ id: string }>) {
  return input.map((item) => ({ id: item.id, processed: true }))
}
```

Not compatible (Next.js route handlers are not directly callable):

```ts
// ❌ Route handler — wrap in a plain function instead
export async function POST(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ ok: true })
}
```

If you use Next.js route handlers, export a separate plain function for workflow replay and call it from your route handler.

#### Streaming Workflows

If your workflow returns a streaming response (e.g., a Vercel AI SDK data-stream from a Next.js route), you need a wrapper that:

1. Calls the route handler directly (no HTTP server required)
2. Parses the stream into a structured result using `readVercelAIStream`
3. Records the result with `recordToolCall`

Create a separate handler file (e.g., `app/api/chat-stream/chatStreamHandler.ts`) that is **only imported by `ed_workflows.ts`**, never by `route.ts` or any Next.js-bundled file:

```ts
// app/api/chat-stream/chatStreamHandler.ts
import { NextRequest } from 'next/server'
import { readVercelAIStream, recordToolCall } from 'elasticdash-test'
import type { VercelAIStreamResult } from 'elasticdash-test'
import { POST } from './route'

export interface ChatStreamInput {
  messages: Array<{ role: string; content: string }>
  sessionId?: string
  userToken?: string
}

export type ChatStreamResult = VercelAIStreamResult

export async function chatStreamHandler(args: ChatStreamInput): Promise<ChatStreamResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (args.userToken) headers['Authorization'] = `Bearer ${args.userToken}`

  const req = new NextRequest('http://localhost/api/chat-stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages: args.messages, ...(args.sessionId ? { sessionId: args.sessionId } : {}) }),
  })

  const response = await POST(req)

  // If the response is not a data-stream, surface the error
  if (response.headers.get('x-vercel-ai-data-stream') !== 'v1') {
    let errorMessage = `HTTP ${response.status}`
    try {
      const json = await response.clone().json() as Record<string, unknown>
      errorMessage = typeof json.error === 'string' ? json.error : JSON.stringify(json)
    } catch {
      errorMessage = await response.text().catch(() => errorMessage)
    }
    return { message: errorMessage, type: 'error', error: errorMessage }
  }

  const result = await readVercelAIStream(response)
  recordToolCall('chatStream', args, result)
  return result
}
```

Then export it from `ed_workflows.ts`:

```ts
// ed_workflows.ts
export { chatStreamHandler } from './app/api/chat-stream/chatStreamHandler'
```

**Key points:**

- `readVercelAIStream` parses the Vercel AI SDK `text/plain` + `x-vercel-ai-data-stream: v1` wire protocol into a structured `VercelAIStreamResult`
- `recordToolCall` is called manually (via the `ed_tools` file) so that inner tool recordings from the pipeline are not suppressed
- The handler file imports `elasticdash-test` directly — keep it isolated from Next.js bundling by only importing it from `ed_workflows.ts`

### Create `ed_tools.ts`

Create `ed_tools.ts` (or `ed_tools.js`) in your project root. Each tool wrapper needs two helpers and a standard pattern:

1. **`resolveMock()`** — checks whether the dashboard has injected mock data for this tool call (supports `mock-all`, `mock-specific`, and `live` modes). Zero-cost no-op outside the worker subprocess.
2. **`safeRecordToolCall()`** — records the tool call via `elasticdash-test`, but only when running inside the worker subprocess. The dynamic import is guarded so it never blocks your production service.

Paste these helpers at the top of `ed_tools.ts`, then wrap each tool using the pattern shown below:

```ts
// ed_tools.ts
import { chargeCard as chargeCardImpl } from './src/services/payments'
import { getOrderDetails as getOrderDetailsImpl } from './src/services/orders'

// ---------------------------------------------------------------------------
// Mock resolution
// ---------------------------------------------------------------------------

/**
 * Checks whether the current call to `toolName` should be short-circuited
 * with mock data. Reads globals written by the elasticdash worker subprocess
 * before the workflow starts.
 *
 * Zero-cost no-op outside the worker: returns { mocked: false } immediately
 * when the globals are absent.
 */
function resolveMock(toolName: string): { mocked: true; result: unknown } | { mocked: false } {
  const g = globalThis as any
  const mocks = g.__ELASTICDASH_TOOL_MOCKS__
  if (!mocks) return { mocked: false }

  const entry = mocks[toolName]
  if (!entry || entry.mode === 'live') return { mocked: false }

  if (!g.__ELASTICDASH_TOOL_CALL_COUNTERS__) g.__ELASTICDASH_TOOL_CALL_COUNTERS__ = {}
  const counters = g.__ELASTICDASH_TOOL_CALL_COUNTERS__
  counters[toolName] = (counters[toolName] ?? 0) + 1
  const callNumber = counters[toolName]

  if (entry.mode === 'mock-all') {
    const data = entry.mockData ?? {}
    const result = data[callNumber] !== undefined ? data[callNumber] : data[0]
    return { mocked: true, result }
  }

  if (entry.mode === 'mock-specific') {
    const indices = entry.callIndices ?? []
    if (indices.includes(callNumber)) {
      return { mocked: true, result: (entry.mockData ?? {})[callNumber] }
    }
    return { mocked: false }
  }

  return { mocked: false }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Records a tool call via elasticdash-test when running inside the worker
 * subprocess. Silently skips in all other environments.
 */
async function safeRecordToolCall(tool: string, input: any, result: any) {
  if (!(globalThis as any).__ELASTICDASH_WORKER__) return
  try {
    const { recordToolCall } = await import('elasticdash-test')
    recordToolCall(tool, input, result)
  } catch (err: any) {
    if (err?.code !== 'MODULE_NOT_FOUND') {
      console.error('Logging Error in Tool:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const chargeCard = async (input: any) => {
  const mock = resolveMock('chargeCard')
  if (mock.mocked) {
    await safeRecordToolCall('chargeCard', input, mock.result)
    return mock.result
  }

  return await chargeCardImpl(input)
    .then(async (res: any) => {
      await safeRecordToolCall('chargeCard', input, res)
      return res
    })
    .catch(async (err: any) => {
      await safeRecordToolCall('chargeCard', input, err)
      throw err
    })
}

export const getOrderDetails = async (input: any) => {
  const mock = resolveMock('getOrderDetails')
  if (mock.mocked) {
    await safeRecordToolCall('getOrderDetails', input, mock.result)
    return mock.result
  }

  return await getOrderDetailsImpl(input)
    .then(async (res: any) => {
      await safeRecordToolCall('getOrderDetails', input, res)
      return res
    })
    .catch(async (err: any) => {
      await safeRecordToolCall('getOrderDetails', input, err)
      throw err
    })
}
```

**Pattern for each tool:**

1. Call `resolveMock('toolName')` — if mocked, record and return the mock result immediately
2. Otherwise run the real implementation with `.then()` / `.catch()`, recording in both paths
3. Always use `safeRecordToolCall` (never import `elasticdash-test` directly) to avoid blocking production

**Important:** The name string passed to `resolveMock()` and `safeRecordToolCall()` must match the exported function name exactly (e.g., `resolveMock('chargeCard')` for `export const chargeCard`). The dashboard uses this name to identify tools for mocking and trace display.

**Next.js projects:** Add `elasticdash-test` to `serverExternalPackages` in your `next.config.ts` (or `next.config.js`):

```ts
// next.config.ts
const nextConfig = {
  serverExternalPackages: ['elasticdash-test'],
}
export default nextConfig
```

This tells Next.js to skip bundling the package into its server-side webpack build and instead load it via Node.js `require()` at runtime. Without this:

- The `dynamic import()` in `safeRecordToolCall` would cause webpack to try resolving `elasticdash-test` at build time — even though it's an optional dev/test dependency that may not be installed in production
- Node.js-specific APIs used by the test framework (filesystem, child processes, etc.) are incompatible with webpack bundling
- By keeping it external, the `catch` block in `safeRecordToolCall` handles `MODULE_NOT_FOUND` silently at runtime instead of failing the build

### Update Workflow Tool Calls

Change your workflows to import tools from `ed_tools.ts` instead of the original source files:

```ts
// ❌ Before
import { chargeCard } from './services/payments'
import { getOrderDetails } from './services/orders'

export const checkoutFlow = async (orderId: string) => {
  const order = await getOrderDetails({ orderId })
  const payment = await chargeCard({ amount: order.total })
  return { orderId, paymentId: payment.id }
}

// ✅ After
import { chargeCard, getOrderDetails } from './ed_tools'

export const checkoutFlow = async (orderId: string) => {
  const order = await getOrderDetails({ orderId })
  const payment = await chargeCard({ amount: order.total })
  return { orderId, paymentId: payment.id }
}
```

### Add Dashboard Script to `package.json`

**Standard setup (most projects):**

```json
{
  "scripts": {
    "dashboard:ai": "elasticdash dashboard"
  }
}
```

**Advanced setup (Next.js, TS path aliases, mixed ESM/CJS):**

If your project uses TypeScript path aliases (e.g., `@/lib/...`) or loads TypeScript at runtime with module complexity:

```json
{
  "scripts": {
    "dashboard:ai": "NODE_OPTIONS='--import tsx/esm --require tsx/cjs --require tsconfig-paths/register' elasticdash dashboard"
  }
}
```

<details>
<summary>When do I need the advanced script?</summary>

**Why this works:**

- `tsx/esm` and `tsx/cjs` handle mixed ESM/CJS module loading at runtime
- `tsconfig-paths/register` resolves path aliases from your `tsconfig.json` (e.g., `@/lib` → `./src/lib`)

**How to check if you're using ESM or CJS:**

Check your `package.json`:

- `"type": "module"` = ESM (uses `import`)
- No `type` field or `"type": "commonjs"` = CJS (uses `require`)

**You need the advanced script when:**

- **Any file in your project uses path aliases** like `@/services/payment` instead of relative imports — **this is the main reason**
- Your project mixes ESM and CJS modules in complex ways
- You see `Cannot find module '@/...'` or `ERR_UNKNOWN_FILE_EXTENSION` errors

**Important:** Path alias resolution is transitive. Even if `ed_workflows.ts` doesn't directly use `@/`, the advanced script is still needed if it imports files that do.

**You DON'T need it when:**

- Plain JavaScript projects
- Basic TypeScript projects with only relative imports (`./` or `../`)
- Pure ESM or pure CJS projects without path aliases
- Pre-compiled projects where dashboard loads `.js` files

</details>

That's it for setup. Your project should now have these files:

```
your-project/
  ed_workflows.ts   # workflow exports
  ed_tools.ts       # instrumented tool wrappers
  package.json      # dashboard script added
  .gitignore        # .temp/ added
```

---

## Section 2: Usage & Example

### End-to-End Example

Here is a complete example showing a workflow, its tools, and how they wire together.

**1. Tool implementations** (`src/services/orders.ts`):

```ts
export async function getOrderDetails(input: { orderId: string }) {
  // Real DB/API call
  return { orderId: input.orderId, total: 49.99, items: ['widget-a'] }
}

export async function chargeCard(input: { amount: number }) {
  // Real payment call
  return { id: 'pay_abc123', amount: input.amount, status: 'succeeded' }
}
```

**2. Instrumented tools** (`ed_tools.ts`):

```ts
import { getOrderDetails as getOrderDetailsImpl } from './src/services/orders'
import { chargeCard as chargeCardImpl } from './src/services/orders'

// resolveMock() and safeRecordToolCall() helpers go here
// (see full definitions in Section 1 above)

export const getOrderDetails = async (input: any) => {
  const mock = resolveMock('getOrderDetails')
  if (mock.mocked) {
    await safeRecordToolCall('getOrderDetails', input, mock.result)
    return mock.result
  }

  return await getOrderDetailsImpl(input)
    .then(async (res: any) => {
      await safeRecordToolCall('getOrderDetails', input, res)
      return res
    })
    .catch(async (err: any) => {
      await safeRecordToolCall('getOrderDetails', input, err)
      throw err
    })
}

export const chargeCard = async (input: any) => {
  const mock = resolveMock('chargeCard')
  if (mock.mocked) {
    await safeRecordToolCall('chargeCard', input, mock.result)
    return mock.result
  }

  return await chargeCardImpl(input)
    .then(async (res: any) => {
      await safeRecordToolCall('chargeCard', input, res)
      return res
    })
    .catch(async (err: any) => {
      await safeRecordToolCall('chargeCard', input, err)
      throw err
    })
}
```

**3. Workflow** (`ed_workflows.ts`):

```ts
import { getOrderDetails, chargeCard } from './ed_tools'

export async function checkoutFlow(input: { orderId: string }) {
  const order = await getOrderDetails({ orderId: input.orderId })
  // LLM calls via fetch() are intercepted automatically — no wrapping needed
  const payment = await chargeCard({ amount: order.total })
  return { orderId: order.orderId, paymentId: payment.id, status: payment.status }
}
```

**4. Test file** (`examples/checkout.ai.test.ts`):

```ts
import 'elasticdash-test/test-setup'
import { expect } from 'expect'

aiTest('checkout flow charges the correct amount', async (ctx) => {
  // Workflow runs; LLM calls and tool calls are recorded into ctx.trace automatically
  const result = await checkoutFlow({ orderId: 'order-42' })

  // Assert an LLM step occurred
  expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4' })

  // Assert the chargeCard tool was called
  expect(ctx.trace).toCallTool('chargeCard')

  // Assert output makes sense semantically
  expect(ctx.trace).toMatchSemanticOutput('payment succeeded')
})
```

### Open the Dashboard

```bash
npm run dashboard
```

### Get Trace Data from Langfuse

When a workflow fails in production, fetch the trace to replay it locally.

**Note:** When fetching recent observations via the API, you may receive an empty array even though the observations are visible on the Langfuse dashboard. This is expected - the API data lags behind the dashboard. Wait a few minutes and retry before contacting Langfuse support.

**Using curl:**

```bash
export LANGFUSE_PUBLIC_KEY="your_public_key"
export LANGFUSE_SECRET_KEY="your_secret_key"
TRACE_ID="your_trace_id"

curl "https://cloud.langfuse.com/api/public/v2/observations?traceId=${TRACE_ID}&fields=time,io,basic,model" \
  -H "Authorization: Basic $(echo -n "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" | base64)" \
  > trace.json
```

**Using Postman:**

1. `GET` `https://cloud.langfuse.com/api/public/v2/observations`
2. Params: `traceId=<your_trace_id>`, `fields=time,io,basic,model`
3. Auth tab: Basic Auth with public key + secret key
4. Save the response as `trace.json`

### Debug with the Dashboard

Once the dashboard is open:

1. **Select the workflow** — find and click your workflow in the list
2. **Upload the trace** — upload `trace.json` and wait for observations to load
3. **Identify problematic steps** — review AI/tool observations and mark the step(s) that need fixes
4. **Iterate on fixes** — re-run selected step(s) from the dashboard, update your code, re-run again until outputs match expectations
5. **Validate end-to-end** — run `Validate with Live Data` to confirm the full workflow produces correct output

### Capture Streaming Flows

ElasticDash can capture and replay non-AI HTTP streaming responses (e.g., SSE/NDJSON endpoints) automatically when your workflow uses normal `fetch`.

Checklist for streaming workflows:

1. Keep stream requests on standard `fetch` calls so the HTTP interceptor can observe them
2. Ensure the upstream response uses a streaming content type:
   - `text/event-stream`
   - `application/x-ndjson`
   - `application/stream+json`
   - `application/jsonl`
3. Consume `Response.body` as a stream in your app logic
4. Run the workflow once live to record stream payloads
5. Re-run with replay to validate deterministic stream-content behavior

Minimal consumer example:

```ts
const response = await fetch('https://example.com/stream')
if (!response.body) throw new Error('Missing stream body')

const reader = response.body.getReader()
const decoder = new TextDecoder()
let raw = ''

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  raw += decoder.decode(value, { stream: true })
}

raw += decoder.decode()
```

**Replay caveat:** ElasticDash preserves payload text and response metadata (status/statusText/headers) but does not preserve original chunk timing or chunk boundaries.

### Next Steps

- `docs/tools.md` — advanced tool instrumentation patterns
- `docs/dashboard.md` — detailed dashboard and Langfuse API usage
- `docs/matchers.md` — matcher reference and provider env vars
- `docs/agents.md` — agent-specific replay features
