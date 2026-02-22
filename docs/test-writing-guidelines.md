# ElasticDash Test Writing Guidelines

This guide shows how to write effective AI workflow tests with `elasticdash-test`, including common scenarios and example snippets.

## Prerequisites
- Node.js >= 20
- `elasticdash-test` installed
- Optional `.env` with API keys (e.g., `OPENAI_API_KEY=...`); loaded automatically by the CLI.

## Test anatomy
- Import test setup once per file: `import 'elasticdash-test/dist/test-setup.js'`
- Each test receives `ctx` with `ctx.trace` to inspect recorded LLM/tool/custom steps.
- Matchers live on `expect` (already registered by `test-setup`).
- Files end with `.ai.test.ts` and use the global `aiTest(name, fn)`.

## Useful matchers (quick reference)
- `toHaveLLMStep(config)`: Assert LLM calls match model/provider/prompt/output filters.
- `toCallTool(name)`: Assert a tool call occurred.
- `toHaveCustomStep(config)`: Assert custom (RAG/code/fixed/custom) steps.
- `toHavePromptWhere(config)`: Filter prompts by substring, then require/include/exclude content (with optional nth/index positional checks).
- `toMatchSemanticOutput(expected, options?)`: LLM-judged semantic match over combined LLM outputs.
- `toEvaluateOutputMetric(config)`: LLM-scored numeric metric (0–1) on a specific LLM step’s prompt or result, with threshold comparisons.

## Patterns and examples

### Validate the order of steps in a workflow
Use `toHavePromptWhere` with `nth` to assert positional prompts.
```ts
aiTest('prompts occur in order', async (ctx) => {
  await runWorkflow()

  // First prompt should be goal validation
  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'Goal Completion Validator',
    nth: 1,
  })

  // Second prompt should be the planner prompt
  expect(ctx.trace).toHavePromptWhere({
    filterContains: "User's Ultimate Goal:",
    nth: 2,
  })
})
```

### Validate fetched data from RAG/APIs used in a workflow
Record custom steps and assert payload/result contents.
```ts
aiTest('RAG includes required source', async (ctx) => {
  await runWorkflow()

  expect(ctx.trace).toHaveCustomStep({
    kind: 'rag',
    contains: 'pokemon_stats',
    resultContains: 'base_stat',
  })
})
```

### Check if the input prompt of a step meets requirements
Target prompt text with `toHaveLLMStep` or `toHavePromptWhere`.
```ts
aiTest('planner prompt mentions schemas', async (ctx) => {
  await runWorkflow()

  expect(ctx.trace).toHaveLLMStep({
    provider: 'openai',
    promptContains: 'VALIDATION APPROACH',
  })
})
```

### Check if the output of a step meets requirements
Use `toHaveLLMStep` with `outputContains`, or `toMatchSemanticOutput` for looser checks.
```ts
aiTest('planner output returns attack stat', async (ctx) => {
  await runWorkflow()

  expect(ctx.trace).toHaveLLMStep({
    outputContains: 'attack stat of Pikachu',
  })
})
```

### Check if the workflow output meets requirements (metric)
Use `toEvaluateOutputMetric` to score a specific LLM step’s result or prompt (0–1) with thresholds.
```ts
aiTest('plan is actionable', async (ctx) => {
  await runWorkflow()

  await expect(ctx.trace).toEvaluateOutputMetric({
    evaluationPrompt:
      'Score 0-1: is this execution plan concrete and directly executable? '
      + '1.0 = concrete SQL with specific tables/columns; 0.0 = vague/placeholder.',
    target: 'result',          // or 'prompt'
    nth: 2,                    // choose which LLM step to evaluate (1-based)
    condition: { atLeast: 0.7 },
    provider: 'claude',        // optional; defaults to openai
    model: 'claude-3-opus-20240229',
  })
})
```

## Tips
- Always `await` async matchers (`toMatchSemanticOutput`, `toEvaluateOutputMetric`).
- Use `nth`/`index` in `toHavePromptWhere` to avoid false positives when multiple prompts contain similar text.
- For OpenAI-compatible endpoints, pass `apiKey` and `baseURL` in matcher options when needed.
- Keep prompts/results concise in tests; log the trace when debugging: `console.log(ctx.trace.getLLMSteps())`.

## Common mistakes
- Passing non-trace values: always assert on `ctx.trace`, not raw strings/objects.
- Empty trace: if you didn’t record steps (or the interceptor didn’t run), matchers have nothing to check.

## Recording basics
- LLM: `ctx.trace.recordLLMStep({ model: 'gpt-4o', prompt, completion })`
- Tool: `ctx.trace.recordToolCall({ name: 'chargeCard', args, result })`
- Custom step: `ctx.trace.recordCustomStep({ kind: 'rag', payload, result, tags })`

## Running tests
```bash
# Run all tests in cwd
elasticdash test

# Run in a subdir
elasticdash test examples/

# Single file
elasticdash run path/to/file.ai.test.ts
```

## Minimal scaffold
```ts
import 'elasticdash-test/dist/test-setup.js'
import { expect } from 'expect'

aiTest('example', async (ctx) => {
  await runWorkflow()
  expect(ctx.trace).toHaveLLMStep({ provider: 'openai' })
})
```
