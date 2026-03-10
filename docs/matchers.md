# Test Matchers

ElasticDash Test provides AI-specific matchers for asserting on workflow traces.

## Overview

All matchers work with `expect(ctx.trace)` after importing the test setup:

```ts
import '../node_modules/elasticdash-test/dist/test-setup.js'
import { expect } from 'expect'

aiTest('my test', async (ctx) => {
  // ... run your workflow
  expect(ctx.trace).toHaveLLMStep({ model: 'gpt-4' })
})
```

---

## `toHaveLLMStep(config?)`

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

### Configuration Options

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

---

## `toCallTool(toolName)`

Assert the trace contains a tool call with the given name.

```ts
expect(ctx.trace).toCallTool('chargeCard')
```

---

## `toMatchSemanticOutput(expected, options?)`

LLM-judged semantic match of combined LLM output vs. the expected string. Defaults to OpenAI GPT-4 with `OPENAI_API_KEY`.

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

---

## `toEvaluateOutputMetric(config)`

Evaluate one LLM step's prompt or result using an LLM and assert a numeric metric condition in the range 0.0–1.0. 

Defaults: `target='result'`, `condition='atLeast 0.7'`, `provider='openai'`, `model='gpt-4'`.

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

### Configuration Options

- `evaluationPrompt` (required): your scoring instructions; model is asked to return only a number between 0 and 1.
- `target`: `'result'` (default) or `'prompt'`. Evaluates that text only.
- `index` / `nth`: pick which LLM step to score (0-based or 1-based). Defaults to the last LLM step.
- `condition`: one of `greaterThan`, `lessThan`, `atLeast`, `atMost`, `equals`; default is `{ atLeast: 0.7 }`.
- `provider` / `model` / `sdk` / `apiKey` / `baseURL`: same shape as `toMatchSemanticOutput`.

---

## `toHaveCustomStep(config?)`

Assert a recorded custom step (RAG/code/fixed/custom) matches filters.

```ts
expect(ctx.trace).toHaveCustomStep({ kind: 'rag', name: 'pokemon-search' })
expect(ctx.trace).toHaveCustomStep({ tag: 'sort:asc' })
expect(ctx.trace).toHaveCustomStep({ contains: 'pikachu' })
expect(ctx.trace).toHaveCustomStep({ resultContains: '25' })
expect(ctx.trace).toHaveCustomStep({ kind: 'rag', minTimes: 1, maxTimes: 2 })
```

---

## `toHavePromptWhere(config)`

Filter prompts, then assert additional constraints. Example: "all prompts containing A must also contain B".

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
