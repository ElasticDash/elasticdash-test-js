# ElasticDash Test

An AI-native test runner for ElasticDash workflow testing. Built for async AI pipelines — not a general-purpose test runner.

- Trace-first: every test receives a `trace` context to record and assert on LLM calls and tool invocations
- Automatic fetch interception for OpenAI, Gemini, and Grok — no manual instrumentation required
- AI-specific matchers: `toHaveLLMStep`, `toCallTool`, `toMatchSemanticOutput`
- Sequential execution, no parallelism overhead
- No Jest dependency

---

## Installation

```bash
npm install elasticdash-test
```

Requires Node 20+.

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

### Globals

After importing `test-setup`, these are available globally — no imports needed:

| Global | Description |
|---|---|
| `aiTest(name, fn)` | Register a test |
| `beforeAll(fn)` | Run once before all tests in the file |
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

**Manual recording:** Use this for providers not covered by the interceptor, or when testing against stubs/mocks:

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

#### `toMatchSemanticOutput(expected)`

Assert the combined LLM output contains the expected string (case-insensitive substring match — designed for a future embedding-based similarity upgrade).

```ts
expect(ctx.trace).toMatchSemanticOutput('order confirmed')
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
