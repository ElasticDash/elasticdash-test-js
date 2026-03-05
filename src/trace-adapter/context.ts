export interface LLMStep {
  model: string
  provider?: string   // 'openai' | 'gemini' | 'grok' | undefined
  prompt?: string
  completion?: string
  contains?: string
}

export interface ToolCall {
  name: string
  args?: Record<string, unknown>
  result?: unknown
}

export type CustomStepKind = 'rag' | 'code' | 'fixed' | 'custom'

export interface CustomStep {
  kind: CustomStepKind
  name?: string
  tags?: string[]
  payload?: unknown
  result?: unknown
  metadata?: Record<string, unknown>
  contains?: string
}

export interface TraceStep {
  type: 'llm' | 'tool' | 'custom'
  timestamp: number
  durationMs: number
  data: Record<string, unknown>
}

export interface TraceHandle {
  /** All recorded steps in this trace session */
  getSteps(): TraceStep[]
  /** Only LLM inference steps */
  getLLMSteps(): LLMStep[]
  /** Only tool-call steps */
  getToolCalls(): ToolCall[]
  /** Only custom steps (RAG, code, fixed, etc.) */
  getCustomSteps(): CustomStep[]
  /** Record an LLM step (used by stubs / real adapter) */
  recordLLMStep(step: LLMStep): void
  /** Record a tool call (used by stubs / real adapter) */
  recordToolCall(call: ToolCall): void
  /** Record a custom step (e.g., RAG, code) */
  recordCustomStep(step: CustomStep): void
}

export interface AITestContext {
  trace: TraceHandle
}

// --- AsyncLocalStorage-backed current trace (parallel-safe) ---
import { AsyncLocalStorage } from 'node:async_hooks'

const g = globalThis as Record<string, unknown>
const TRACE_ALS_KEY = '__elasticdash_trace_als__'
const traceAls: AsyncLocalStorage<TraceHandle | undefined> =
  (g[TRACE_ALS_KEY] as AsyncLocalStorage<TraceHandle | undefined>) ??
  new AsyncLocalStorage<TraceHandle | undefined>()
if (!g[TRACE_ALS_KEY]) g[TRACE_ALS_KEY] = traceAls

export function setCurrentTrace(trace: TraceHandle | undefined): void {
  traceAls.enterWith(trace)
}

export function getCurrentTrace(): TraceHandle | undefined {
  return traceAls.getStore()
}

/** Extension points for runner hooks (scaffold for future backend integration) */
export interface RunnerHooks {
  onTestStart?(name: string): void | Promise<void>
  onTestFinish?(name: string, passed: boolean, durationMs: number, error?: Error): void | Promise<void>
  onTraceComplete?(name: string, trace: TraceHandle): void | Promise<void>
}

/**
 * Create a stubbed trace handle for a single test execution.
 * Later this can be replaced with a real ElasticDash backend call.
 */
export function createTraceHandle(): TraceHandle {
  const steps: TraceStep[] = []
  const llmSteps: LLMStep[] = []
  const toolCalls: ToolCall[] = []
  const customSteps: CustomStep[] = []

  return {
    getSteps() {
      return steps
    },

    getLLMSteps() {
      return llmSteps
    },

    getToolCalls() {
      return toolCalls
    },

    getCustomSteps() {
      return customSteps
    },

    recordLLMStep(step: LLMStep) {
      llmSteps.push(step)
      steps.push({
        type: 'llm',
        timestamp: Date.now(),
        durationMs: 0,
        data: step as unknown as Record<string, unknown>,
      })
    },

    recordToolCall(call: ToolCall) {
      toolCalls.push(call)
      steps.push({
        type: 'tool',
        timestamp: Date.now(),
        durationMs: 0,
        data: call as unknown as Record<string, unknown>,
      })
    },

    recordCustomStep(step: CustomStep) {
      customSteps.push(step)
      steps.push({
        type: 'custom',
        timestamp: Date.now(),
        durationMs: 0,
        data: step as unknown as Record<string, unknown>,
      })
    },
  }
}

/**
 * Start a trace session before a test and return the context + a finalise fn.
 */
export function startTraceSession(): { context: AITestContext; finalise: () => void } {
  const trace = createTraceHandle()
  const context: AITestContext = { trace }
  return {
    context,
    finalise() {
      // Placeholder: flush / send to ElasticDash backend here in the future
    },
  }
}
