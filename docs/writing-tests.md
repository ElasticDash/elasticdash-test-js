# Writing Tests with elasticdash-test

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | >= 20 |
| `tsx` (TypeScript runner) | latest |
| `elasticdash-test` package | installed |

Environment variables (e.g. LLM API keys) are loaded automatically from a `.env` file in the project root at CLI startup. Create one if it does not exist:

```
OPENAI_API_KEY=sk-...
```

---

## Test File Structure

Test files must end in `.ai.test.ts`. Each file uses the global `aiTest` function (injected by the runner) and imports `expect` from `elasticdash-test`.

```typescript
import { expect } from 'elasticdash-test'

aiTest('my test name', async (ctx) => {
  // ctx.trace  — TraceHandle for recording and asserting on LLM/tool activity
  // ctx        — AITestContext (may gain more fields in future releases)
})
```

The runner registers all custom matchers before any test runs, so you do not need to call `registerMatchers()` yourself.

---

## Recording LLM Steps

If your code under test calls an LLM but does not automatically record into the trace, record the output manually:

```typescript
aiTest('planner produces an execution plan', async (ctx) => {
  const result = await sendToPlanner(query, data, context, 'FETCH', false)

  // Record so trace-aware matchers can inspect the output
  ctx.trace.recordLLMStep({
    model: 'gpt-4o',           // model name (use 'unknown' if unavailable)
    completion: result,        // the text the LLM returned
    prompt: query,             // optional: the prompt sent
  })

  expect(ctx.trace).toMatchSemanticOutput('execution_plan')
})
```

If your production code integrates with the `TraceHandle` directly, it can call `ctx.trace.recordLLMStep(...)` internally and you do not need to repeat it in the test.

---

## Recording Tool Calls

```typescript
ctx.trace.recordToolCall({
  name: 'sendEmail',
  args: { to: 'user@example.com', subject: 'Hello' },
  result: { status: 'sent' },
})
```

---

## Custom Matchers

All three matchers expect a `TraceHandle` as the value passed to `expect()`. Always use `ctx.trace`, not the raw return value of your function.

### `toHaveLLMStep(config?)`

Asserts the trace contains at least one LLM step matching the optional config.

```typescript
// At least one LLM step was recorded
expect(ctx.trace).toHaveLLMStep()

// At least one step from a specific model
expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4o' })

// At least one step whose output contains a keyword
expect(ctx.trace).toHaveLLMStep({ contains: 'order confirmed' })

// Both filters applied together
expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4o', contains: 'order confirmed' })
```

### `toCallTool(toolName)`

Asserts the trace contains a call to the named tool.

```typescript
expect(ctx.trace).toCallTool('chargeCard')
expect(ctx.trace).toCallTool('sendEmail')
```

### `toMatchSemanticOutput(expected)`

Asserts that the combined text of all recorded LLM completions contains `expected` (case-insensitive substring match). A future release may replace this with embedding-based similarity.

```typescript
expect(ctx.trace).toMatchSemanticOutput('execution_plan')
expect(ctx.trace).toMatchSemanticOutput('user not found')
```

---

## Common Mistakes

### Passing the raw result instead of `ctx.trace`

This is the most frequent error. Trace matchers call `.getLLMSteps()` internally; if you pass a string or other non-trace value, you will get:

```
Expected a TraceHandle (ctx.trace) but received string.
Use: expect(ctx.trace).toMatchSemanticOutput(...)
```

```typescript
// WRONG — result is a string
expect(result).toMatchSemanticOutput('execution_plan')

// CORRECT — ctx.trace is the TraceHandle
expect(ctx.trace).toMatchSemanticOutput('execution_plan')
```

### Forgetting to record before asserting

If you assert on `ctx.trace` but never called `ctx.trace.recordLLMStep(...)` or `ctx.trace.recordToolCall(...)`, the trace is empty and all trace matchers will fail.

```typescript
// WRONG — trace is empty, assertion always fails
const result = await callMyLLM(prompt)
expect(ctx.trace).toHaveLLMStep({ contains: 'hello' })

// CORRECT — record first, then assert
const result = await callMyLLM(prompt)
ctx.trace.recordLLMStep({ model: 'gpt-4o', completion: result })
expect(ctx.trace).toHaveLLMStep({ contains: 'hello' })
```

---

## Running Tests

```bash
# Run all tests in the examples/ directory
npx tsx src/cli.ts test examples/

# Run tests in a specific directory
npx tsx src/cli.ts test .temp/

# If the package is installed globally or linked
elasticdash-test test examples/
```

The CLI exits with code `0` if all tests pass, or `1` if any test fails.
