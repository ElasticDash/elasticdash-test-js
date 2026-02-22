import { expect } from 'expect'
import type { TraceHandle, LLMStep, CustomStep, CustomStepKind } from '../trace-adapter/context.js'

interface LLMStepConfig {
  model?: string
  contains?: string        // searches prompt + completion
  promptContains?: string  // searches only in step.prompt
  outputContains?: string  // searches only in step.completion
  provider?: string        // 'openai' | 'claude' | 'gemini' | 'grok'
  times?: number           // match count must equal exactly this value
  minTimes?: number        // match count must be >= this value
  maxTimes?: number        // match count must be <= this value
}

interface CustomStepConfig {
  kind?: CustomStepKind
  name?: string
  tag?: string
  contains?: string          // searches payload/result/metadata stringified
  resultContains?: string    // searches result only
  payloadContains?: string   // searches payload only
  metadataContains?: string  // searches metadata only
  times?: number
  minTimes?: number
  maxTimes?: number
}

interface PromptWhereConfig {
  filterContains: string           // first filter: prompts that contain this substring
  requireContains?: string         // then assert: filtered prompts must also contain this
  requireNotContains?: string      // and must NOT contain this
  times?: number                   // exact count of filtered prompts
  minTimes?: number                // min count of filtered prompts
  maxTimes?: number                // max count of filtered prompts
  index?: number                   // optional 0-based index into filtered prompts to check specifically
  nth?: number                     // optional 1-based alias for index
}

type SupportedProvider = 'openai' | 'claude' | 'gemini' | 'grok'

interface SemanticMatchOptions {
  provider?: SupportedProvider
  model?: string
  sdk?: unknown // optional user-supplied SDK instance
  apiKey?: string // optional API key override (useful for OpenAI-compatible endpoints)
  baseURL?: string // optional base URL override for OpenAI-compatible APIs
}

type EvaluationTarget = 'prompt' | 'result'

interface EvaluationCondition {
  greaterThan?: number
  lessThan?: number
  atLeast?: number
  atMost?: number
  equals?: number
}

interface EvaluateOutputMetricConfig {
  evaluationPrompt: string
  target?: EvaluationTarget       // 'prompt' or 'result'; default 'result'
  index?: number                  // 0-based index into LLM steps
  nth?: number                    // 1-based alias for index
  condition?: EvaluationCondition // optional; default atLeast 0.7
  provider?: SupportedProvider
  model?: string
  sdk?: unknown                   // optional SDK instance
  apiKey?: string                 // optional API key override (useful for OpenAI-compatible endpoints)
  baseURL?: string                // optional base URL override for OpenAI-compatible APIs
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

const defaultModels: Record<SupportedProvider, string> = {
  openai: 'gpt-4.1',
  claude: 'claude-3-opus-20240229',
  gemini: 'gemini-1.5-pro',
  grok: 'grok-beta',
}

// Helper: call an LLM provider (or SDK) and return the text content
async function callProviderLLM(
  prompt: string,
  options: SemanticMatchOptions = {},
  systemPrompt = 'You are an expert test judge.',
  maxTokens = 32,
  temperature = 0
): Promise<string> {
  const provider: SupportedProvider = options.provider ?? 'openai'
  const sdk = options.sdk as any | undefined
  const resolvedModel = options.model ?? defaultModels[provider]

  switch (provider) {
    case 'openai': {
      if (sdk && sdk.chat?.completions?.create) {
        const resp = await sdk.chat.completions.create({
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          temperature,
        })
        return resp?.choices?.[0]?.message?.content?.trim() ?? ''
      }

      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('Provide apiKey or set OPENAI_API_KEY for OpenAI-compatible endpoint.')

      const baseURL = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`)
      }
      const data: any = await response.json()
      return data.choices?.[0]?.message?.content?.trim() ?? ''
    }

    case 'claude': {
      if (sdk && sdk.messages?.create) {
        const resp = await sdk.messages.create({
          model: resolvedModel,
          max_tokens: maxTokens,
          temperature,
          messages: [{ role: 'user', content: `${systemPrompt}\n\n${prompt}` }],
        })
        return resp?.content?.[0]?.text?.trim() ?? ''
      }

      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in environment.')

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: resolvedModel,
          max_tokens: maxTokens,
          temperature,
          messages: [{ role: 'user', content: `${systemPrompt}\n\n${prompt}` }],
        }),
      })

      if (!response.ok) {
        throw new Error(`Claude API error: ${response.status} ${response.statusText}`)
      }
      const data: any = await response.json()
      return data?.content?.[0]?.text?.trim() ?? ''
    }

    case 'gemini': {
      if (sdk && sdk.models?.generateContent) {
        const resp = await sdk.models.generateContent({
          model: resolvedModel,
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        })
        return resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
      }

      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
      if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set in environment.')

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          }),
        }
      )

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`)
      }
      const data: any = await response.json()
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
    }

    case 'grok': {
      if (sdk && sdk.chat?.completions?.create) {
        const resp = await sdk.chat.completions.create({
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          temperature,
        })
        return resp?.choices?.[0]?.message?.content?.trim() ?? ''
      }

      const apiKey = process.env.GROK_API_KEY
      if (!apiKey) throw new Error('GROK_API_KEY is not set in environment.')

      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
      })

      if (!response.ok) {
        throw new Error(`Grok API error: ${response.status} ${response.statusText}`)
      }
      const data: any = await response.json()
      return data.choices?.[0]?.message?.content?.trim() ?? ''
    }

    default:
      throw new Error(`Unsupported provider: ${provider}`)
  }
}

// Helper: Call an LLM (configurable provider/model/sdk) to judge semantic match
async function llmJudgeSemanticMatch(
  traceOutput: string,
  expected: string,
  options: SemanticMatchOptions = {}
): Promise<boolean> {
  const prompt = `
You are an expert test judge. Given the following AI trace output and an expected semantic result, answer "YES" if the trace output semantically matches the expectation, otherwise answer "NO".

Trace Output:
${traceOutput}

Expected:
${expected}

Answer only "YES" or "NO".
  `.trim()

  const content = (await callProviderLLM(prompt, options, 'You are an expert test judge.', 8, 0)).trim().toUpperCase()
  return content.startsWith('YES')
}

function parseFirstNumber(text: string): number | null {
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const num = Number.parseFloat(match[0])
  return Number.isFinite(num) ? num : null
}

function resolveCondition(config?: EvaluationCondition): { kind: keyof EvaluationCondition; value: number } {
  const entries = Object.entries(config || {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)) as Array<
    [keyof EvaluationCondition, number]
  >
  if (entries.length === 0) return { kind: 'atLeast', value: 0.7 }
  if (entries.length > 1) {
    throw new Error('Provide only one metric condition (greaterThan, lessThan, atLeast, atMost, equals).')
  }
  return { kind: entries[0][0], value: entries[0][1] }
}

function checkCondition(score: number, condition: { kind: keyof EvaluationCondition; value: number }): boolean {
  switch (condition.kind) {
    case 'greaterThan':
      return score > condition.value
    case 'lessThan':
      return score < condition.value
    case 'atLeast':
      return score >= condition.value
    case 'atMost':
      return score <= condition.value
    case 'equals':
      return score === condition.value
    default:
      return false
  }
}

// Augment the `expect` package so TypeScript knows about custom matchers
declare module 'expect' {
  interface Matchers<R> {
    toHaveLLMStep(config?: LLMStepConfig): R
    toCallTool(toolName: string): R
    toMatchSemanticOutput(expected: string, options?: SemanticMatchOptions): R
    toHaveCustomStep(config?: CustomStepConfig): R
    /**
     * Filter prompts that contain `filterContains`, then assert additional requirements.
     * Example: prompts containing "A" must also contain "B".
     */
    toHavePromptWhere(config: PromptWhereConfig): R
    /**
     * Evaluate a specific LLM step's prompt or result via an LLM and assert a numeric metric condition (0.0–1.0).
     */
    toEvaluateOutputMetric(config: EvaluateOutputMetricConfig): Promise<R>
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

      const count = matching.length
      let pass: boolean
      if (config.times !== undefined) {
        pass = count === config.times
      } else if (config.minTimes !== undefined || config.maxTimes !== undefined) {
        const min = config.minTimes ?? 0
        const max = config.maxTimes ?? Infinity
        pass = count >= min && count <= max
      } else {
        pass = count > 0
      }

      return {
        pass,
        message: () => {
          if (pass) {
            return `Expected trace NOT to have LLM step matching ${JSON.stringify(config)}`
          }
          const stepSummary =
            steps.length === 0
              ? 'no LLM steps were recorded'
              : `${count} matching step(s) found; recorded steps: ${JSON.stringify(steps)}`
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

    async toMatchSemanticOutput(trace: TraceHandle, expected: string, options?: SemanticMatchOptions) {
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
        const pass = await llmJudgeSemanticMatch(fullOutput, expected, options)
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

    async toEvaluateOutputMetric(trace: TraceHandle, config: EvaluateOutputMetricConfig) {
      if (!isTraceHandle(trace)) {
        return {
          pass: false,
          message: () =>
            `Expected a TraceHandle (ctx.trace) but received ${typeof trace}.
Use: expect(ctx.trace).toEvaluateOutputMetric(...)`,
        }
      }
      if (!config || !config.evaluationPrompt) {
        return {
          pass: false,
          message: () => 'toEvaluateOutputMetric requires evaluationPrompt',
        }
      }

      const steps = trace.getLLMSteps()
      if (steps.length === 0) {
        return {
          pass: false,
          message: () => 'No LLM steps recorded; cannot evaluate output metric.',
        }
      }

      const targetIdx = config.index ?? (config.nth !== undefined ? config.nth - 1 : steps.length - 1)
      if (targetIdx < 0 || targetIdx >= steps.length) {
        return {
          pass: false,
          message: () => `LLM steps length ${steps.length}, but index/nth points to ${targetIdx}.`,
        }
      }

      const targetStep = steps[targetIdx]
      const targetField: EvaluationTarget = config.target ?? 'result'
      const targetText = targetField === 'prompt' ? targetStep.prompt ?? '' : targetStep.completion ?? ''
      if (!targetText) {
        return {
          pass: false,
          message: () => `Selected LLM step has empty ${targetField}; cannot evaluate.`,
        }
      }

      const condition = (() => {
        try {
          return resolveCondition(config.condition)
        } catch (err) {
          return err as Error
        }
      })()
      if (condition instanceof Error) {
        return {
          pass: false,
          message: () => condition.message,
        }
      }

      const evalPrompt = `
Evaluation prompt (from user):
${config.evaluationPrompt}

Score the following text strictly between 0 and 1 (inclusive). Respond with only the number.

Text:
${targetText}
      `.trim()

      try {
        const raw = await callProviderLLM(
          evalPrompt,
          { provider: config.provider, model: config.model, sdk: config.sdk, apiKey: config.apiKey, baseURL: config.baseURL },
          'You are an evaluation assistant. Return only a number between 0 and 1.',
          16,
          0
        )
        const score = parseFirstNumber(raw)
        if (score === null) {
          return {
            pass: false,
            message: () => `Could not parse numeric metric from model response: "${raw}"`,
          }
        }
        if (score < 0 || score > 1) {
          return {
            pass: false,
            message: () => `Metric ${score} is out of allowed range 0.0–1.0 (raw: "${raw}")`,
          }
        }

        const pass = checkCondition(score, condition)
        return {
          pass,
          message: () => {
            if (pass) {
              return `Expected metric NOT to satisfy ${condition.kind} ${condition.value} (score ${score})`
            }
            return `Metric check failed: score ${score} did not satisfy ${condition.kind} ${condition.value}. Raw response: "${raw}"`
          },
        }
      } catch (err) {
        return {
          pass: false,
          message: () => `LLM evaluation failed: ${(err as Error).message}`,
        }
      }
    },

    toHaveCustomStep(trace: TraceHandle, config: CustomStepConfig = {}) {
      if (!isTraceHandle(trace) || typeof (trace as any).getCustomSteps !== 'function') {
        return {
          pass: false,
          message: () =>
            `Expected a TraceHandle (ctx.trace with getCustomSteps) but received ${typeof trace}.\nUse: expect(ctx.trace).toHaveCustomStep(...)`,
        }
      }

      const steps = (trace as any).getCustomSteps() as CustomStep[]

      const matchString = (val: unknown): string => {
        if (val === undefined || val === null) return ''
        if (typeof val === 'string') return val
        try {
          return JSON.stringify(val)
        } catch {
          return String(val)
        }
      }

      const matching = steps.filter((step) => {
        if (config.kind && step.kind !== config.kind) return false
        if (config.name && step.name !== config.name) return false
        if (config.tag && !(step.tags || []).includes(config.tag)) return false

        const payloadStr = matchString(step.payload).toLowerCase()
        const resultStr = matchString(step.result).toLowerCase()
        const metaStr = matchString(step.metadata).toLowerCase()
        const combined = [payloadStr, resultStr, metaStr].filter(Boolean).join(' ')

        if (config.contains && !combined.includes(config.contains.toLowerCase())) return false
        if (config.payloadContains && !payloadStr.includes(config.payloadContains.toLowerCase())) return false
        if (config.resultContains && !resultStr.includes(config.resultContains.toLowerCase())) return false
        if (config.metadataContains && !metaStr.includes(config.metadataContains.toLowerCase())) return false

        return true
      })

      const count = matching.length
      let pass: boolean
      if (config.times !== undefined) {
        pass = count === config.times
      } else if (config.minTimes !== undefined || config.maxTimes !== undefined) {
        const min = config.minTimes ?? 0
        const max = config.maxTimes ?? Infinity
        pass = count >= min && count <= max
      } else {
        pass = count > 0
      }

      return {
        pass,
        message: () => {
          if (pass) {
            return `Expected trace NOT to have custom step matching ${JSON.stringify(config)}`
          }
          const stepSummary =
            steps.length === 0
              ? 'no custom steps were recorded'
              : `${count} matching step(s) found; recorded custom steps: ${JSON.stringify(steps)}`
          return `Expected trace to have custom step matching ${JSON.stringify(config)}, but ${stepSummary}`
        },
      }
    },

    toHavePromptWhere(trace: TraceHandle, config: PromptWhereConfig) {
      if (!isTraceHandle(trace)) {
        return {
          pass: false,
          message: () =>
            `Expected a TraceHandle (ctx.trace) but received ${typeof trace}.\nUse: expect(ctx.trace).toHavePromptWhere(...)`,
        }
      }
      if (!config || !config.filterContains) {
        return {
          pass: false,
          message: () => 'toHavePromptWhere requires filterContains',
        }
      }

      const filterNeedle = config.filterContains.toLowerCase()
      const requireNeedle = config.requireContains?.toLowerCase()
      const forbidNeedle = config.requireNotContains?.toLowerCase()

      const prompts = trace.getLLMSteps().map((s) => s.prompt ?? '')

      const filtered = prompts.filter((p) => p.toLowerCase().includes(filterNeedle))

      // Optional positional check (index or nth)
      const targetIdx = config.index ?? (config.nth !== undefined ? config.nth - 1 : undefined)

      let checked: string[] = []
      let count = 0
      let pass = true

      if (targetIdx !== undefined) {
        if (targetIdx < 0 || targetIdx >= filtered.length) {
          return {
            pass: false,
            message: () =>
              `Filtered prompts length ${filtered.length}, but index/nth points to ${targetIdx}. Config: ${JSON.stringify(config)}`,
          }
        }
        const p = filtered[targetIdx]
        const lower = p.toLowerCase()
        const okRequire = requireNeedle ? lower.includes(requireNeedle) : true
        const okForbid = forbidNeedle ? !lower.includes(forbidNeedle) : true
        pass = okRequire && okForbid
        checked = okRequire && okForbid ? [p] : []
        count = checked.length
      } else {
        checked = filtered.filter((p) => {
          const lower = p.toLowerCase()
          if (requireNeedle && !lower.includes(requireNeedle)) return false
          if (forbidNeedle && lower.includes(forbidNeedle)) return false
          return true
        })

        count = checked.length

        if (config.times !== undefined) {
          pass = count === config.times
        } else {
          const min = config.minTimes ?? 0
          const max = config.maxTimes ?? Infinity
          pass = count >= min && count <= max
        }

        // Also ensure that if requireContains is set, no filtered prompt violates it
        if (requireNeedle) {
          const violating = filtered.filter((p) => !p.toLowerCase().includes(requireNeedle))
          if (violating.length > 0) pass = false
        }
        if (forbidNeedle) {
          const violating = filtered.filter((p) => p.toLowerCase().includes(forbidNeedle))
          if (violating.length > 0) pass = false
        }
      }

      return {
        pass,
        message: () => {
          if (pass) {
            return `Expected prompts NOT to satisfy filter/require combo: ${JSON.stringify(config)}`
          }
          const base = [`Expected prompts filtered by "${config.filterContains}" to satisfy requirements`]
          if (config.requireContains) base.push(`requireContains: "${config.requireContains}"`)
          if (config.requireNotContains) base.push(`requireNotContains: "${config.requireNotContains}"`)
          if (targetIdx !== undefined) {
            base.push(`checked index: ${targetIdx}`, `filtered count: ${filtered.length}`)
          } else {
            base.push(`filtered count: ${filtered.length}, passing count: ${checked.length}`)
            base.push(
              config.times !== undefined
                ? `expected exactly ${config.times}`
                : `expected between ${config.minTimes ?? 0} and ${config.maxTimes ?? Infinity}`,
            )
          }
          return base.filter(Boolean).join('; ')
        },
      }
    },
  })
}

// Export our patched expect so users can import it and get the correct type and runtime matchers
export { expect }