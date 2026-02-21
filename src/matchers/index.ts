import { expect } from 'expect'
import type { TraceHandle, LLMStep } from '../trace-adapter/context.js'

interface LLMStepConfig {
  model?: string
  contains?: string
}

// Augment the `expect` package so TypeScript knows about custom matchers
declare module 'expect' {
  interface Matchers<R> {
    toHaveLLMStep(config?: LLMStepConfig): R
    toCallTool(toolName: string): R
    toMatchSemanticOutput(expected: string): R
  }
}

/**
 * Register all AI-specific custom matchers onto the `expect` instance.
 * Call this once on runner startup.
 */
export function registerMatchers(): void {
  expect.extend({
    /**
     * Assert the trace contains at least one LLM step matching the config.
     * Usage: expect(trace).toHaveLLMStep({ model: "gpt-4", contains: "order confirmed" })
     */
    toHaveLLMStep(trace: TraceHandle, config: LLMStepConfig = {}) {
      const steps = trace.getLLMSteps()

      const matching = steps.filter((step: LLMStep) => {
        if (config.model && step.model !== config.model) return false
        if (config.contains) {
          const haystack = [step.completion, step.prompt, step.contains]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(config.contains.toLowerCase())) return false
        }
        return true
      })

      const pass = matching.length > 0

      return {
        pass,
        message: () => {
          if (pass) {
            return `Expected trace NOT to have LLM step matching ${JSON.stringify(config)}`
          }
          const stepSummary =
            steps.length === 0
              ? 'no LLM steps were recorded'
              : `recorded steps: ${JSON.stringify(steps)}`
          return `Expected trace to have LLM step matching ${JSON.stringify(config)}, but ${stepSummary}`
        },
      }
    },

    /**
     * Assert the trace contains a tool call with the given name.
     * Usage: expect(trace).toCallTool("chargeCard")
     */
    toCallTool(trace: TraceHandle, toolName: string) {
      const calls = trace.getToolCalls()
      const pass = calls.some((c) => c.name === toolName)

      return {
        pass,
        message: () => {
          if (pass) {
            return `Expected trace NOT to call tool "${toolName}"`
          }
          const names = calls.map((c) => c.name)
          const recorded = names.length === 0 ? 'no tool calls were recorded' : `recorded: [${names.join(', ')}]`
          return `Expected tool "${toolName}" to be called, but ${recorded}`
        },
      }
    },

    /**
     * Assert the trace output semantically matches an expected string.
     * For MP: simple substring/case-insensitive match.
     * Later: can swap in embedding-based similarity.
     * Usage: expect(trace).toMatchSemanticOutput("order confirmed")
     */
    toMatchSemanticOutput(trace: TraceHandle, expected: string) {
      const steps = trace.getLLMSteps()
      const fullOutput = steps
        .map((s: LLMStep) => [s.completion, s.contains].filter(Boolean).join(' '))
        .join(' ')
        .toLowerCase()

      const pass = fullOutput.includes(expected.toLowerCase())

      return {
        pass,
        message: () => {
          if (pass) {
            return `Expected trace output NOT to semantically match "${expected}"`
          }
          return `Expected trace output to semantically match "${expected}", but got: "${fullOutput || '(empty)'}"`
        },
      }
    },
  })
}
