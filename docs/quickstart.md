# Quick Start Guide

Get ElasticDash running in 10 minutes and start debugging your workflows.

## Table of Contents

- [Quick Start Guide](#quick-start-guide)
  - [Table of Contents](#table-of-contents)
  - [Step 1: Install the SDK](#step-1-install-the-sdk)
    - [Add `.temp` to `.gitignore`](#add-temp-to-gitignore)
  - [Step 2: Configure Environment Variables](#step-2-configure-environment-variables)
  - [Step 3: Create `ed_workflows.ts` (or `ed_workflows.js`)](#step-3-create-ed_workflowsts-or-ed_workflowsjs)
    - [What Can Be Exported in `ed_workflows.ts/js`](#what-can-be-exported-in-ed_workflowstsjs)
  - [Step 4: Create `ed_tools.ts` (or `ed_tools.js`)](#step-4-create-ed_toolsts-or-ed_toolsjs)
  - [Step 5: Update Workflow Tool Calls](#step-5-update-workflow-tool-calls)
  - [Step 6: Add Dashboard Shortcut to `package.json`](#step-6-add-dashboard-shortcut-to-packagejson)
  - [Step 7: Get Trace Data from Langfuse](#step-7-get-trace-data-from-langfuse)
  - [Step 8: Open the Dashboard](#step-8-open-the-dashboard)
  - [Step 9: Select the Workflow](#step-9-select-the-workflow)
  - [Step 10: Upload the Trace JSON](#step-10-upload-the-trace-json)
  - [Step 11: Select Problematic Step(s)](#step-11-select-problematic-steps)
  - [Step 12: Modify Code and Re-Run Selected Steps](#step-12-modify-code-and-re-run-selected-steps)
  - [Step 13: Re-Run the Full Workflow](#step-13-re-run-the-full-workflow)
  - [Capture Streaming Flows](#capture-streaming-flows)
  - [Next Steps](#next-steps)

---

## Step 1: Install the SDK

```bash
npm install elasticdash-test
```

### Add `.temp` to `.gitignore`

ElasticDash writes runtime artifacts (for example, dashboard snapshots) under `.temp/`. Add it to `.gitignore` so temporary files are not committed.

```gitignore
.temp/
```

## Step 2: Configure Environment Variables

Set API keys for the LLM providers used in your workflows.

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

Only set keys for providers you actually use. Supported provider env var names are documented in `docs/matchers.md`.

## Step 3: Create `ed_workflows.ts` (or `ed_workflows.js`)

Export all workflow functions you want to debug:

```ts
// ed_workflows.ts
export { checkoutFlow, refundFlow } from './src/workflows'
export { processOrderFlow } from './src/flows/orders'
```

### What Can Be Exported in `ed_workflows.ts/js`

Your exported workflow must be a directly callable function with JSON-serializable input/output.

Valid shape examples:

```ts
export async function checkoutFlow(input: { orderId: string }) {
  return { ok: true, orderId: input.orderId }
}

export async function batchFlow(input: Array<{ id: string }>) {
  return input.map((item) => ({ id: item.id, processed: true }))
}
```

Not compatible as direct workflow exports:

```ts
// Next.js route handler style (not directly callable by dashboard workflow runner)
export async function POST(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ ok: true })
}
```

If you are using Next.js route handlers, export a separate plain function for workflow replay and call that function from your route handler.

## Step 4: Create `ed_tools.ts` (or `ed_tools.js`)

Wrap your tool functions with tracing instrumentation:

```ts
// ed_tools.ts
import { chargeCard as chargeCardImpl } from './src/services/payments'
import { getOrderDetails as getOrderDetailsImpl } from './src/services/orders'

export const chargeCard = async (input: any) => {
  return await chargeCardImpl(input)
    .then(async (res: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('chargeCard', input, res)
      } catch {
        // tracing must never block the main service path
      }
      return res
    })
    .catch(async (err: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('chargeCard', input, err)
      } catch {
        // tracing must never block the main service path
      }
      throw err
    })
}

export const getOrderDetails = async (input: any) => {
  return await getOrderDetailsImpl(input)
    .then(async (res: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('getOrderDetails', input, res)
      } catch {
        // tracing must never block the main service path
      }
      return res
    })
    .catch(async (err: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('getOrderDetails', input, err)
      } catch {
        // tracing must never block the main service path
      }
      throw err
    })
}
```

## Step 5: Update Workflow Tool Calls

Change workflows to call tools from `ed_tools.ts/js` instead of original source files:

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

## Step 6: Add Dashboard Shortcut to `package.json`

**Standard setup (most projects):**

```json
{
  "scripts": {
    "dashboard": "elasticdash dashboard"
  }
}
```

**Advanced setup (Next.js, TS path aliases, mixed ESM/CJS):**

If your project uses TypeScript path aliases (e.g., `@/lib/...`) or loads TypeScript at runtime with module complexity, use:

```json
{
  "scripts": {
    "dashboard:ai": "NODE_OPTIONS='--import tsx/esm --require tsx/cjs --require tsconfig-paths/register' elasticdash dashboard"
  }
}
```

**Why this works:**
- `tsx/esm` and `tsx/cjs` handle mixed ESM/CJS module loading at runtime
- `tsconfig-paths/register` resolves path aliases from your `tsconfig.json` (e.g., `@/lib` → `./src/lib`)

**How to check if you're using ESM or CJS:**

Check your `package.json`:
- `"type": "module"` = ESM (uses `import`)
- No `type` field or `"type": "commonjs"` = CJS (uses `require`)

**When you need the advanced script:**
- **Any file in your project uses path aliases** like `@/services/payment` instead of relative imports (`../`) - **this is the main reason**
- Your project mixes ESM (`import`) and CJS (`require`) modules in complex ways
- You see `Cannot find module '@/...'` or `ERR_UNKNOWN_FILE_EXTENSION` errors

**Important:** Path alias resolution is transitive. Even if `ed_workflows.ts` doesn't directly use `@/`, the advanced script is still needed if it imports files that do.

**When you DON'T need it:**
- Plain JavaScript projects
- **Basic TypeScript projects with only relative imports** (`./` or `../`) - the dashboard handles standard TS transpilation automatically
- **Pure ESM or pure CJS projects without path aliases**
- Pre-compiled projects where dashboard loads `.js` files

Then run:

```bash
npm run dashboard
# or for advanced setup:
npm run dashboard:ai
```

Or use directly:

```bash
npx elasticdash dashboard
```

## Step 7: Get Trace Data from Langfuse

When a test fails, use the trace ID to fetch observations and save them locally:

```bash
# Export your Langfuse credentials
export LANGFUSE_PUBLIC_KEY="your_public_key"
export LANGFUSE_SECRET_KEY="your_secret_key"

# Replace with your trace ID
TRACE_ID="your_trace_id"

# Fetch observations and save locally
curl "https://cloud.langfuse.com/api/public/v2/observations?traceId=${TRACE_ID}&fields=time,io,basic,model" \
  -H "Authorization: Basic $(echo -n "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" | base64)" \
  > trace.json
```

Or use Postman:

1. Create a `GET` request to `https://cloud.langfuse.com/api/public/v2/observations`
2. Add params: `traceId=<your_trace_id>` and `fields=time,io,basic,model`
3. In the `Auth` tab, select `Basic Auth` and enter public key + secret key
4. Click `Send`
5. Save the JSON response as `trace.json`

## Step 8: Open the Dashboard

```bash
npm run dashboard
```

Or:

```bash
npx elasticdash dashboard
```

## Step 9: Select the Workflow

1. Find your workflow in the list
2. Click the workflow you want to modify

## Step 10: Upload the Trace JSON

1. Upload `trace.json`
2. Wait for observations to load

## Step 11: Select Problematic Step(s)

1. Review AI/tool observations
2. Mark the step(s) that need fixes

## Step 12: Modify Code and Re-Run Selected Steps

1. Re-run selected step(s) from the dashboard to see if the issue can be reliably reproduced
2. Update your codebase
3. Re-run selected step(s) from the dashboard
4. Iterate until outputs match expectations

## Step 13: Re-Run the Full Workflow

1. Run `Validate with Live Data`
2. Confirm end-to-end output is now correct

## Capture Streaming Flows

ElasticDash can capture and replay non-AI HTTP streaming responses (for example SSE/NDJSON endpoints) automatically when your workflow uses normal `fetch`.

Use this checklist for streaming workflows:

1. Keep stream requests on standard `fetch` calls so the HTTP interceptor can observe them.
2. Ensure the upstream response uses a streaming content type:
   - `text/event-stream`
   - `application/x-ndjson`
   - `application/stream+json`
   - `application/jsonl`
3. Consume `Response.body` as a stream in your app logic.
4. Run the workflow/test once live to record stream payloads.
5. Re-run with replay to validate deterministic stream-content behavior.

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

Replay caveat:

- ElasticDash preserves payload text and response metadata (status/statusText/headers).
- ElasticDash replay does not preserve original chunk timing or chunk boundaries.

## Next Steps

- `docs/tools.md` for advanced tool instrumentation patterns
- `docs/dashboard.md` for detailed dashboard and Langfuse API usage
- `docs/matchers.md` for matcher reference and provider env vars
- `docs/agents.md` for agent-specific replay features
