import { expect } from 'expect'
import type { TraceHandle, LLMStep } from '../trace-adapter/context.js'

interface LLMStepConfig {
  model?: string
  contains?: string        // searches prompt + completion
  promptContains?: string  // searches only in step.prompt
  outputContains?: string  // searches only in step.completion
  provider?: string        // 'openai' | 'gemini' | 'grok'
}

/**
 * Type guard: returns true only if `value` looks like a TraceHandle.
 * Used to produce a clear error message when a non-trace value (e.g. a plain
 * string) is passed to a trace-aware matcher.
 */
function isTraceHandle(value: unknown): value is TraceHandle {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as TraceHandle).getLLMSteps === 'function' &&
    typeof (value as TraceHandle).getToolCalls === 'function'
  )
}

// Helper: Call OpenAI GPT-4.1 to judge semantic match
async function llmJudgeSemanticMatch(traceOutput: string, expected: string): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in environment.')

  const prompt = `
You are an expert test judge. Given the following AI trace output and an expected semantic result, answer "YES" if the trace output semantically matches the expectation, otherwise answer "NO".

Trace Output:
${traceOutput}

Expected:
${expected}

Answer only "YES" or "NO".
  `.trim()

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4-1106-preview',
      messages: [
        { role: 'system', content: 'You are an expert test judge.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 5,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`)
  }

  const data: any = await response.json()
  const content = data.choices?.[0]?.message?.content?.trim().toUpperCase() || ''
  return content.startsWith('YES')
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
    toHaveLLMStep(trace: TraceHandle, config: LLMStepConfig = {}) {
      if (!isTraceHandle(trace)) {
        return {
          pass: false,
          message: () =>
            `Expected a TraceHandle (ctx.trace) but received ${typeof trace}.\nUse: expect(ctx.trace).toHaveLLMStep(...)`,
        }
      }
      const steps = trace.getLLMSteps()

      const matching = steps.filter((step: LLMStep) => {
        if (config.model && step.model !== config.model) return false
        if (config.provider && step.provider !== config.provider) return false
        if (config.contains) {
          const haystack = [step.completion, step.prompt, step.contains]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(config.contains.toLowerCase())) return false
        }
        if (config.promptContains) {
          const promptHaystack = (step.prompt ?? '').toLowerCase()
          if (!promptHaystack.includes(config.promptContains.toLowerCase())) return false
        }
        if (config.outputContains) {
          const outputHaystack = (step.completion ?? '').toLowerCase()
          if (!outputHaystack.includes(config.outputContains.toLowerCase())) return false
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

    toCallTool(trace: TraceHandle, toolName: string) {
      if (!isTraceHandle(trace)) {
        return {
          pass: false,
          message: () =>
            `Expected a TraceHandle (ctx.trace) but received ${typeof trace}.\nUse: expect(ctx.trace).toCallTool(...)`,
        }
      }
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

    async toMatchSemanticOutput(trace: TraceHandle, expected: string) {
      if (!isTraceHandle(trace)) {
        return {
          pass: false,
          message: () =>
            `Expected a TraceHandle (ctx.trace) but received ${typeof trace}.\nUse: expect(ctx.trace).toMatchSemanticOutput(...)`,
        }
      }
      const steps = trace.getLLMSteps()
      const fullOutput = steps
        .map((s: LLMStep) => [s.completion, s.contains].filter(Boolean).join(' '))
        .join(' ')
        .trim()

      try {
        const pass = await llmJudgeSemanticMatch(fullOutput, expected)
        return {
          pass,
          message: () => {
            if (pass) {
              return `Expected trace output NOT to semantically match "${expected}" (LLM judged YES)`
            }
            return `Expected trace output to semantically match "${expected}", but LLM judged NO. Trace output: "${fullOutput || '(empty)'}"`
          },
        }
      } catch (err) {
        return {
          pass: false,
          message: () =>
            `LLM semantic match failed: ${(err as Error).message}`,
        }
      }
    },
  })
}

// Export our patched expect so users can import it and get the correct type and runtime matchers
export { expect }