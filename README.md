# ElasticDash Test

An AI-native test runner for ElasticDash workflow testing. Built for async AI pipelines — not a general-purpose test runner.

- Trace-first: every test receives a `trace` context to record and assert on LLM calls and tool invocations
- Automatic fetch interception for OpenAI, Gemini, and Grok — no manual instrumentation required
- AI-specific matchers: `toHaveLLMStep`, `toCallTool`, `toMatchSemanticOutput`, `toHaveCustomStep`, `toHavePromptWhere`, `toEvaluateOutputMetric`
- Sequential execution, no parallelism overhead
- No Jest dependency

---

## Installation

```bash
npm install elasticdash-test
```

Requires Node 20+. For Deno projects, see [Using elasticdash-test in Deno](docs/deno.md).

---

## Quick Start

**1. Write a test file** (`my-flow.ai.test.ts`):

```ts
import '../node_modules/elasticdash-test/dist/test-setup.js'
import { expect } from 'expect'

aiTest('checkout flow', async (ctx) => {
  await runCheckout(ctx)

  expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4', contains: 'order confirmed' })
  expect(ctx.trace).toCallTool('chargeCard')
})
```

**2. Run it:**

```bash
elasticdash test              # discover all *.ai.test.ts files
elasticdash test ./ai-tests   # discover in a specific directory
elasticdash run my-flow.ai.test.ts  # run a single file
```

**3. Read the output:**

```
  ✓ checkout flow (1.2s)
  ✗ refund flow (0.8s)
    → Expected tool "chargeCard" to be called, but no tool calls were recorded

2 passed
1 failed
Total: 3
Duration: 3.4s
```

---

## Writing Tests

See the full guide in [docs/test-writing-guidelines.md](docs/test-writing-guidelines.md).

### Globals

After importing `test-setup`, these are available globally — no imports needed:

| Global | Description |
|---|---|
| `aiTest(name, fn)` | Register a test |
| `beforeAll(fn)` | Run once before all tests in the file |
| `beforeEach(fn)` | Run before every test in the file |
| `afterEach(fn)` | Run after every test in the file (runs even if the test fails) |
| `afterAll(fn)` | Run once after all tests in the file |

### Test context

Each test function receives a `ctx: AITestContext` argument:

```ts
aiTest('my test', async (ctx) => {
  // ctx.trace — record and inspect LLM steps and tool calls
})
```

### Recording trace data

**Automatic interception (recommended):** When your workflow code makes real API calls to OpenAI, Gemini, or Grok, the runner intercepts them automatically and records the LLM step — no changes to your workflow code needed. See [Automatic AI Interception](#automatic-ai-interception) below.

**Manual recording:** Use this for providers not covered by the interceptor, when testing against stubs/mocks, or to capture RAG / code / fixed steps:

```ts
ctx.trace.recordLLMStep({
  model: 'gpt-4',
  prompt: 'What is the order status?',
  completion: 'The order has been confirmed.',
})

ctx.trace.recordToolCall({
  name: 'chargeCard',
  args: { amount: 99.99 },
})

// Record custom workflow steps (RAG fetches, code/fixed steps, etc.)
ctx.trace.recordCustomStep({
  kind: 'rag',              // 'rag' | 'code' | 'fixed' | 'custom'
  name: 'pokemon-search',
  tags: ['sort:asc', 'source:db'],
  payload: { query: 'pikachu attack' },
  result: { ids: [25] },
  metadata: { latencyMs: 120 },
})
```

### Matchers

#### `toHaveLLMStep(config?)`

Assert the trace contains at least one LLM step matching the given config. All fields are optional and combined with AND logic.

```ts
expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4' })
expect(ctx.trace).toHaveLLMStep({ contains: 'order confirmed' })       // searches prompt + completion
expect(ctx.trace).toHaveLLMStep({ promptContains: 'order status' })    // searches prompt only
expect(ctx.trace).toHaveLLMStep({ outputContains: 'order confirmed' }) // searches completion only
expect(ctx.trace).toHaveLLMStep({ provider: 'openai' })
expect(ctx.trace).toHaveLLMStep({ provider: 'openai', promptContains: 'order status' })
expect(ctx.trace).toHaveLLMStep({ promptContains: 'retry', times: 3 })      // exactly 3 matching steps
expect(ctx.trace).toHaveLLMStep({ provider: 'openai', minTimes: 2 })        // at least 2 matching steps
expect(ctx.trace).toHaveLLMStep({ outputContains: 'error', maxTimes: 1 })   // at most 1 matching step
```

| Field | Description |
|---|---|
| `model` | Exact model name match (e.g. `'gpt-4o'`) |
| `contains` | Substring match across prompt + completion (case-insensitive) |
| `promptContains` | Substring match in prompt only (case-insensitive) |
| `outputContains` | Substring match in completion only (case-insensitive) |
| `provider` | Provider name: `'openai'`, `'gemini'`, or `'grok'` |
| `times` | Exact match count (fails unless exactly this many steps match) |
| `minTimes` | Minimum match count (steps matching must be ≥ this value) |
| `maxTimes` | Maximum match count (steps matching must be ≤ this value) |

#### `toCallTool(toolName)`

Assert the trace contains a tool call with the given name.

```ts
expect(ctx.trace).toCallTool('chargeCard')
```

#### `toMatchSemanticOutput(expected, options?)`

LLM-judged semantic match of combined LLM output vs. the expected string. Defaults to OpenAI GPT-4.1 with `OPENAI_API_KEY`. Optional options:

```ts
expect(ctx.trace).toMatchSemanticOutput('attack stat', {
  provider: 'claude',               // 'openai' (default) | 'claude' | 'gemini' | 'grok'
  model: 'claude-3-opus-20240229',  // overrides default model for the provider
  sdk: myClaudeClient,              // optional SDK instance (uses its chat/messages API)
})

// Minimal, using default OpenAI model
expect(ctx.trace).toMatchSemanticOutput('order confirmed')

// OpenAI-compatible endpoint (e.g., Moonshot/Kimi) via baseURL + apiKey
expect(ctx.trace).toMatchSemanticOutput('order confirmed', {
  provider: 'openai',
  model: 'kimi-k2-turbo-preview',
  apiKey: process.env.KIMI_API_KEY,
  baseURL: 'https://api.moonshot.ai/v1',
})
```

Environment keys by provider: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `GROK_API_KEY`.
For OpenAI-compatible endpoints, pass `apiKey`/`baseURL` in options or set an appropriate env var used by your SDK.

#### `toEvaluateOutputMetric(config)`

Evaluate one LLM step’s prompt or result using an LLM and assert a numeric metric condition in the range 0.0–1.0. Defaults: target=`result`, condition=`atLeast 0.7`, provider=`openai`, model=`gpt-4.1`.

```ts
// Evaluate the last LLM result with your own prompt; default condition atLeast 0.7
expect(ctx.trace).toEvaluateOutputMetric({
  evaluationPrompt: 'Rate how well this answers the user question.',
})

// Check a specific step (3rd LLM prompt), target the prompt text, require >= 0.8 via Claude
expect(ctx.trace).toEvaluateOutputMetric({
  evaluationPrompt: 'Score coherence of this prompt between 0 and 1.',
  target: 'prompt',
  nth: 3,
  condition: { atLeast: 0.8 },
  provider: 'claude',
  model: 'claude-3-opus-20240229',
})

// Custom comparator: score must be < 0.3
expect(ctx.trace).toEvaluateOutputMetric({
  evaluationPrompt: 'Rate hallucination risk (0=none, 1=high).',
  condition: { lessThan: 0.3 },
})
```

Options:
- `evaluationPrompt` (required): your scoring instructions; model is asked to return only a number between 0 and 1.
- `target`: `'result'` (default) or `'prompt'`. Mutually exclusive; evaluates that text only.
- `index` / `nth`: pick which LLM step to score (0-based or 1-based). Defaults to the last LLM step.
- `condition`: one of `greaterThan`, `lessThan`, `atLeast`, `atMost`, `equals`; default is `{ atLeast: 0.7 }`. Fails if the score is outside 0.0–1.0 or cannot be parsed.
- `provider` / `model` / `sdk` / `apiKey` / `baseURL`: same shape as `toMatchSemanticOutput` (supports OpenAI, Claude, Gemini, Grok, and OpenAI-compatible via `baseURL`). Requires corresponding API key if no SDK is supplied.

#### `toHaveCustomStep(config?)`

Assert a recorded custom step (RAG/code/fixed/custom) matches filters.

```ts
expect(ctx.trace).toHaveCustomStep({ kind: 'rag', name: 'pokemon-search' })
expect(ctx.trace).toHaveCustomStep({ tag: 'sort:asc' })
expect(ctx.trace).toHaveCustomStep({ contains: 'pikachu' })
expect(ctx.trace).toHaveCustomStep({ resultContains: '25' })
expect(ctx.trace).toHaveCustomStep({ kind: 'rag', minTimes: 1, maxTimes: 2 })
```

#### `toHavePromptWhere(config)`

Filter prompts, then assert additional constraints. Example: “all prompts containing A must also contain B”.

```ts
// Prompts that contain "order" must also contain "confirmed"
expect(ctx.trace).toHavePromptWhere({
  filterContains: 'order',
  requireContains: 'confirmed',
})

// Prompts containing "retry" must NOT contain "cancel"
expect(ctx.trace).toHavePromptWhere({
  filterContains: 'retry',
  requireNotContains: 'cancel',
})

// And control counts on the filtered subset
expect(ctx.trace).toHavePromptWhere({
  filterContains: 'order',
  requireContains: 'confirmed',
  minTimes: 1,
  maxTimes: 3,
})

// Check a specific prompt position (1-based nth or 0-based index)
expect(ctx.trace).toHavePromptWhere({
  filterContains: 'order',
  requireContains: 'confirmed',
  nth: 3, // the 3rd prompt among those containing "order"
})
```

---

## Automatic AI Interception

The runner patches `globalThis.fetch` before tests run and automatically records LLM steps for calls to the following endpoints:

| Provider | Endpoints intercepted |
|---|---|
| **OpenAI** | `api.openai.com/v1/chat/completions`, `/v1/completions` |
| **Gemini** | `generativelanguage.googleapis.com/.../models/...:generateContent` |
| **Grok** (xAI) | `api.x.ai/v1/chat/completions` |

Each intercepted call records `model`, `provider`, `prompt`, and `completion` into `ctx.trace` automatically. Your workflow code needs no changes.

```ts
aiTest('user lookup flow', async (ctx) => {
  // This makes a real OpenAI call — intercepted automatically
  await myWorkflow.run('Find all active users')

  // Works without any ctx.trace.recordLLMStep() in your workflow
  expect(ctx.trace).toHaveLLMStep({ promptContains: 'Find all active users' })
  expect(ctx.trace).toHaveLLMStep({ provider: 'openai' })
})
```

**Streaming:** When `stream: true` is set on a request, the completion is recorded as `"(streamed)"` — the prompt and model are still captured.

**Libraries using `https.request` directly** (older versions of some SDKs) are not covered by fetch interception. Use manual `ctx.trace.recordLLMStep()` for those.

### Recording flow steps without passing `ctx.trace` (AsyncLocalStorage)

The runner now sets a per-test `currentTrace` using Node’s `AsyncLocalStorage`, so your app code can record steps without threading `ctx.trace` through every function. This remains safe under parallel execution.

```ts
// In your test
import { setCurrentTrace } from 'elasticdash-test'

aiTest('flow test', async (ctx) => {
  setCurrentTrace(ctx.trace)          // bind the trace to the current async context
  await runFlowWithoutTraceArg()      // your existing code
  // assertions
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

Notes:
- Works per async context; if you spawn detached work (child processes/independent workers), pass `trace` explicitly there.
- Still compatible with manual DI: you can continue passing `ctx.trace` explicitly if you prefer.

### Optional local LLM capture proxy (for Supabase Edge / Deno)
- Opt in by setting `ELASTICDASH_LLM_PROXY=1` (optional: `ELASTICDASH_LLM_PROXY_PORT`, default `8787`). The runner will start a local proxy and generate a per-test `ELASTICDASH_TRACE_ID`.
- Point your LLM client at the proxy via base URL envs (e.g., `OPENAI_BASE_URL=http://localhost:8787/v1`, `ANTHROPIC_API_URL=http://localhost:8787`). No code changes in your workflow; only env overrides when running tests.
- Forward the trace ID to your Edge/Deno code (e.g., add `x-trace-id: process.env.ELASTICDASH_TRACE_ID` on the request to your Supabase Edge function). The proxy records model/prompt/completion (or `(streamed)`) and the runner folds captured steps back into `ctx.trace` after each test.
- When `ELASTICDASH_LLM_PROXY` is unset, behavior is unchanged and the existing Node fetch interceptor remains the default.

---

## Configuration

Create an optional `elasticdash.config.ts` at the project root:

```ts
export default {
  testMatch: ['**/*.ai.test.ts'],
  traceMode: 'local' as const,
}
```

| Option | Default | Description |
|---|---|---|
| `testMatch` | `['**/*.ai.test.ts']` | Glob patterns for test discovery |
| `traceMode` | `'local'` | `'local'` (stub) or `'remote'` (future ElasticDash backend) |

---

## TypeScript Setup

Add an `examples/tsconfig.json` (or your test directory's `tsconfig.json`) that extends the root config and includes the `src` types:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "rootDir": "..",
    "noEmit": true
  },
  "include": [
    "../src/**/*",
    "./**/*"
  ]
}
```

This gives you typed `aiTest`, `beforeAll`, `afterAll` globals and typed custom matchers in your test files.

---

## Workflows Dashboard

Browse and search all available workflow functions in your project:

```bash
elasticdash dashboard         # open dashboard at http://localhost:4573
elasticdash dashboard --port 4572  # use custom port
elasticdash dashboard --no-open    # skip auto-opening browser
```

The dashboard scans your workflow/tool files and displays:
  - If both `.ts` and `.js` versions of a file exist (e.g., `ed_workflows.ts` and `ed_workflows.js`), the dashboard will always use the `.ts` file.
  - If only `.ts` exists, it will be automatically transpiled to `.js` before scanning/importing—no manual build step required.
  - If only `.js` exists, it will be used directly.

This means you can write your workflows and tools in TypeScript, and the dashboard will handle transpilation automatically. You do not need to run `tsc` or build manually for dashboard usage.

**Example file selection logic:**
| Scenario                | File Used         |
|-------------------------|------------------|
| Only `ed_workflows.ts`   | Transpiled `.ts` |
| Only `ed_workflows.js`   | `.js`            |
| Both exist              | `.ts` (preferred)|

The dashboard displays:
  - **Function names** — all exported functions in the module
  - **Signatures** — function parameters and return types
  - **Async indicator** — marks async vs sync functions
  - **Source module** — where the function is imported from (if re-exported)
  - **File path** — location of the workflow file

Use the search field to filter workflows by:
- **Name** — find workflow by function name (e.g., `checkoutFlow`)
- **Source module** — find all workflows from a specific module (e.g., `app.workflows`)
- **File path** — filter by location in your codebase

This is useful for discovering available workflows, understanding their signatures, and identifying where functions are defined before calling them in tests.

### `ed_workflows.ts`, `ed_tools.ts`, `ed_agents.ts`

These optional files bundle and re-export existing functions from your codebase for use in tests.

#### `ed_workflows.ts`

Re-export workflow functions from your application:

```ts
// ed_workflows.ts
export { orderWorkflow, refundWorkflow } from './src/workflows'
export { userLookupFlow } from './src/user-flows'
```

Access in tests:

```ts
import { orderWorkflow } from './ed_workflows'

aiTest('full order workflow', async (ctx) => {
  const result = await orderWorkflow('order-123', 'cust-456')
  expect(ctx.trace).toCallTool('chargeCard')
})
```

#### `ed_tools.ts`

Re-export tool functions that agents or workflows can invoke:

```ts
// ed_tools.ts
export { chargeCard, fetchOrderStatus, sendNotification } from './src/tools'
```

#### `ed_agents.ts`

Re-export agent functions or create a config object:

```ts
// ed_agents.ts
export { checkoutAgent, paymentAgent } from './src/agents'

// Or as a config object:
export const agents = {
  checkout: checkoutAgent,
  payment: paymentAgent,
}
```

The dashboard command will scan these files and display all exported functions with their signatures, making it easy to explore your workflow API.

---

## Agent Mid-Trace Replay

ElasticDash supports resuming a long-running agent from any task in its plan — without re-executing already-completed steps. This is useful for:

- **Resuming after failures**: If task 3 of 5 fails, fix the issue and re-run from task 3 only.
- **Pausing for approval**: Capture state after task 2, get human sign-off, then continue.
- **Debugging in isolation**: Re-run a single task with modified input to diagnose a problem.

### How it works

Agents are structured as an **AgentPlan** — an ordered list of **AgentTask** objects, each with a tool name, input, and output. When serialized, the plan plus all captured trace events form an **AgentState** that can be saved to disk/database and replayed later.

### Quick start

```ts
import { plannerAgent, executorAgent, resumeAgentFromTrace } from './ed_agents'
import { serializeAgentState, deserializeAgentState } from 'elasticdash-test'
import fs from 'node:fs'

// 1. Generate a plan
const plan = await plannerAgent('Show me sales for Q1', { userToken: 'tok-abc' })

// 2. Execute the plan (runs all tasks sequentially)
const completedPlan = await executorAgent(plan)

// 3. Serialize and save state (e.g., after partial execution)
const state = serializeAgentState(completedPlan, [] /* pass recorder.events in worker context */)
fs.writeFileSync('agent-state.json', JSON.stringify(state, null, 2))

// 4. Later: load saved state and resume from task 2 (0-based index 1)
const savedState = JSON.parse(fs.readFileSync('agent-state.json', 'utf8'))
const stateToResume = deserializeAgentState({ ...savedState, resumeFromTaskIndex: 1 })
const resumedPlan = await resumeAgentFromTrace(stateToResume)

console.log('Resumed plan status:', resumedPlan.status)
console.log('Task outputs:', resumedPlan.tasks.map((t) => ({ id: t.id, status: t.status })))
```

### AgentState structure

```ts
interface AgentState {
  plan: AgentPlan               // Full plan with all tasks (completed and pending)
  trace: WorkflowEvent[]        // Captured trace events from previous execution
  resumeFromTaskIndex: number   // Zero-based index — tasks before this are loaded from cache
}

interface AgentPlan {
  id: string
  tasks: AgentTask[]
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'paused'
  currentTaskIndex: number
  context: Record<string, unknown>
  metadata: Record<string, unknown>
}

interface AgentTask {
  id: string
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  description: string
  tool: string          // Name of the tool function to invoke
  input: unknown        // May contain { $ref: "task-N.output.fieldName" } placeholders
  output?: unknown      // Populated after execution
  error?: string
  startedAt?: number
  completedAt?: number
}
```

### Task input placeholders

Task inputs can reference previous task outputs using `{ $ref: "taskId.output.fieldPath" }`:

```ts
// task-2 uses the embedding produced by task-1
{
  id: 'task-2',
  tool: 'taskSelectorService',
  input: {
    queryEmbedding: { $ref: 'task-1.output.embedding' },
    topK: 3,
  }
}
```

Placeholders are resolved at execution time by `resolveTaskInput()`.

### Dashboard integration

When running an agent workflow through the dashboard:

1. Agent task observations are **visually highlighted** with a purple background and left border, making them easy to identify.
2. Each agent observation shows a **T1 / T2 / T3** badge indicating which task it belongs to.
3. In the observation detail panel, a **"Resume from Task N"** button appears (agent steps only — non-agent steps have no button).
4. Clicking it calls `/api/resume-agent-from-task` with the serialized `AgentState` and the chosen `taskIndex`, then adds the resumed run as a new trace in the comparison table.

### Best practices for resumable agents

- **Keep tasks idempotent** where possible — if a task must be re-run, ensure it produces the same result.
- **Store minimal outputs** — only record what downstream tasks need, not full API responses.
- **Version your state schema** — if tool interfaces change, old states may need migration.
- **Use sequential tasks** — the current implementation runs tasks one-by-one; parallel task support is a planned future enhancement.

---

## Project Structure

```
src/
  cli.ts                 CLI entry point (commander + fast-glob)
  runner.ts              Sequential test runner engine
  reporter.ts            Color-coded terminal output
  test-setup.ts          Import in test files for globals + matcher types
  index.ts               Programmatic API
  core/
    registry.ts          aiTest / beforeAll / afterAll registry
  trace-adapter/
    context.ts           TraceHandle, AITestContext, RunnerHooks scaffold
  matchers/
    index.ts             Custom expect matchers
  interceptors/
    ai-interceptor.ts    Automatic fetch interceptor for OpenAI / Gemini / Grok
```

---

## Programmatic API

```ts
import { runFiles, reportResults, registerMatchers, installAIInterceptor, uninstallAIInterceptor } from 'elasticdash-test'

registerMatchers()
installAIInterceptor()   // patch globalThis.fetch for automatic LLM tracing

const results = await runFiles(['./tests/flow.ai.test.ts'])
reportResults(results)

uninstallAIInterceptor() // restore original fetch when done
```

---

## Recording Tool Calls Explicitly

If you want to ensure tool calls are always recorded in the workflow trace—regardless of how your tools are imported or used—you can use the `recordToolCall` utility provided by this SDK.

### How to Use


1. Import the function in your tool implementation:

```ts
import { recordToolCall } from 'elasticdash-test'

export async function myTool(input: string) {
  // ...tool logic...
  const result = `Hello, ${input}!`
  recordToolCall('myTool', { input }, result)
  return result
}
```

2. When running under ElasticDash, all calls to `recordToolCall` will be captured in the workflow trace. When running locally or outside the runner, this function is a no-op and will not affect your code.

**This approach is robust and works with both imported and global tools.**

**Summary:**
- Use tools as globals (no import) for full traceability and automatic tool call capture.
- This approach keeps your workflow code clean and enables powerful debugging and analytics in ElasticDash.

## Non-Goals

This runner intentionally does not support:

- Parallel execution
- Watch mode
- Snapshot testing
- Coverage reporting
- Jest compatibility

---

## License

MIT
