# ElasticDash Test

An AI-native test runner for ElasticDash workflow testing. Built for async AI pipelines — not a general-purpose test runner.

## Quick Links

### Jump to Key Sections
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [Tool Recording](#tool-recording)
- [Configuration](#configuration)

### Open Detailed Docs
- **[Quick Start Guide](docs/quickstart.md)** ← Start here to set up your first workflow
- [Test Writing Guidelines](docs/test-writing-guidelines.md)
- [Test Matchers](docs/matchers.md)
- [Tool Recording and Replay](docs/tools.md)
- [Workflows Dashboard](docs/dashboard.md)
- [Agent Mid-Trace Replay](docs/agents.md)
- [Deno Support](docs/deno.md)

## Features

- 🎯 **Trace-first testing** — every test gets a `trace` context to record and assert on LLM calls and tool invocations
- 🔍 **Automatic AI interception** — captures OpenAI, Gemini, and Grok calls without code changes
- 🧪 **AI-specific matchers** — semantic output matching, LLM-judged evaluations, prompt assertions
- 🛠️ **Tool recording & replay** — automatically trace tool calls with checkpoint-based replay
- 📊 **Interactive dashboard** — browse workflows, debug traces, validate fixes visually
- 🤖 **Agent mid-trace replay** — resume long-running agents from any task without re-execution

---

## Installation

```bash
npm install elasticdash-test
```

**Requirements:** Node 20+. For Deno projects, see [Using elasticdash-test in Deno](docs/deno.md).

**Running CLI commands:** Use `npx` to run commands with your locally installed version (recommended to avoid version drift):

```bash
npx elasticdash test
npx elasticdash dashboard
```

Alternatively, install globally if you prefer shorter commands:

```bash
npm install -g elasticdash-test
elasticdash test
elasticdash dashboard
```

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
npx elasticdash test              # discover all * *.ai.test.ts files
npx elasticdash test ./ai-tests   # discover in a specific directory
npx elasticdash run my-flow.ai.test.ts  # run a single file
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

## Documentation

### Core Concepts
- **[Test Writing Guidelines](docs/test-writing-guidelines.md)** — comprehensive guide to writing AI workflow tests
- **[Test Matchers](docs/matchers.md)** — all available matchers with examples
- **[Tool Recording & Replay](docs/tools.md)** — automatic tool tracing and checkpoint-based replay

### Advanced Features  
- **[Workflows Dashboard](docs/dashboard.md)** — interactive workflow browser, debugger, and fetching traces from Langfuse
- **[Agent Mid-Trace Replay](docs/agents.md)** — resume long-running agents from any task
- **[Deno Support](docs/deno.md)** — using ElasticDash Test in Deno projects

---

## Quick Reference

### Test Globals

| Global | Description |
|---|---|
| `aiTest(name, fn)` | Register a test |
| `beforeAll(fn)` | Run once before all tests in the file |
| `beforeEach(fn)` | Run before every test in the file |
| `afterEach(fn)` | Run after every test in the file (runs even if test fails) |
| `afterAll(fn)` | Run once after all tests in the file |

### Recording Trace Data

**Automatic (recommended):** Workflow code making real API calls to OpenAI, Gemini, or Grok is automatically intercepted and recorded.

**Manual (for custom providers or mocks):**

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

ctx.trace.recordCustomStep({
  kind: 'rag',
  name: 'pokemon-search',
  payload: { query: 'pikachu' },
  result: { ids: [25] },
})
```

### Common Matchers

```ts
// Assert LLM calls
expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4' })
expect(ctx.trace).toHaveLLMStep({ promptContains: 'order status' })

// Assert tool calls
expect(ctx.trace).toCallTool('chargeCard')

// Semantic output matching (LLM-judged)
expect(ctx.trace).toMatchSemanticOutput('order confirmed')

// Custom steps (RAG, code, fixed)
expect(ctx.trace).toHaveCustomStep({ kind: 'rag', name: 'pokemon-search' })
```

**→ See [Test Matchers](docs/matchers.md) for complete documentation**

---

## Automatic AI & Tool Tracing

### AI Interception

The runner automatically intercepts and records calls to:
- OpenAI (`api.openai.com`)
- Gemini (`generativelanguage.googleapis.com`)
- Grok/xAI (`api.x.ai`)

No code changes needed — just run your workflow and assertions work automatically.

### Tool Recording

Manual instrumentation pattern: isolate tracing in the service `.then/.catch` path so tracing failures never block business logic:

```ts
import { runSelectQuery } from './services/dataService'

export const dataService = async (input: any) => {
  const { query } = input as { query: string }
  return await runSelectQuery(query)
    .then(async (res: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('dataService', input, res)
      } catch {
        // tracing must never block the main service path
      }
      return res
    })
    .catch(async (err: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('dataService', input, err)
      } catch {
        // tracing must never block the main service path
      }
      throw err
    })
}
```

In manual mode, always isolate tracing in a separate `try/catch` so trace logging errors cannot interrupt core service execution.

**→ See [Tool Recording & Replay](docs/tools.md) for checkpoint-based replay and freezing**

---

## Configuration

Optional `elasticdash.config.ts` at project root:

```ts
export default {
  testMatch: ['**/*.ai.test.ts'],
  traceMode: 'local' as const,
}
```

Optional project file: `ed_workers.ts` can be used by your app architecture (for example, exporting worker handlers), but it is not required or discovered by the ElasticDash CLI/dashboard.

## TypeScript Setup

For typed globals and matchers, extend your test directory's `tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "include": ["../src/**/*", "./**/*"]
}
```

---

## Programmatic API

```ts
import { runFiles, reportResults, registerMatchers, installAIInterceptor } from 'elasticdash-test'

registerMatchers()
installAIInterceptor()

const results = await runFiles(['./tests/flow.ai.test.ts'])
reportResults(results)
```

---

## License

MIT
