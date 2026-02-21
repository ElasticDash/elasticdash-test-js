import '../src/test-setup.js'
import { expect } from '../src/matchers/index.js'
import type { AITestContext } from '../src/trace-adapter/context.js'

// Simulate an LLM call that records itself into the trace
async function fakeLLMCall(ctx: AITestContext): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  ctx.trace.recordLLMStep({
    model: 'gpt-4',
    prompt: 'Is the order confirmed?',
    completion: 'Yes, order confirmed successfully.',
    contains: 'order confirmed',
  })
}

// Simulate a tool invocation
async function fakeToolCall(ctx: AITestContext): Promise<void> {
  ctx.trace.recordToolCall({ name: 'chargeCard', args: { amount: 99.99 } })
}

aiTest('simple LLM flow', async (ctx) => {
  await fakeLLMCall(ctx)

  expect(ctx.trace).toHaveLLMStep({
    model: 'gpt-4',
  })
})

aiTest('checkout flow', async (ctx) => {
  await fakeLLMCall(ctx)
  await fakeToolCall(ctx)

  expect(ctx.trace).toHaveLLMStep({
    model: 'gpt-4',
    contains: 'order confirmed',
  })

  expect(ctx.trace).toCallTool('chargeCard')

  expect(ctx.trace).toMatchSemanticOutput('order confirmed')
})

aiTest('failing example — missing tool call', async (ctx) => {
  await fakeLLMCall(ctx)

  // This will fail because we never called 'sendEmail'
  expect(ctx.trace).toCallTool('sendEmail')
})
