# ElasticDash Test

An AI-native test runner for ElasticDash workflow testing. Built for async AI pipelines — not a general-purpose test runner.

- Trace-first: every test receives a `trace` context to record and assert on LLM calls and tool invocations
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

Your AI workflow code should call these on `ctx.trace` to make assertions possible:

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

Assert the trace contains at least one LLM step matching the given config. All fields are optional.

```ts
expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4' })
expect(ctx.trace).toHaveLLMStep({ contains: 'order confirmed' })
expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4', contains: 'order confirmed' })
```

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
```

---

## Programmatic API

```ts
import { runFiles, reportResults, registerMatchers } from 'elasticdash-test'

registerMatchers()
const results = await runFiles(['./tests/flow.ai.test.ts'])
reportResults(results)
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
