export interface LLMStep {
  model: string
  prompt?: string
  completion?: string
  contains?: string
}

export interface ToolCall {
  name: string
  args?: Record<string, unknown>
  result?: unknown
}

export interface TraceStep {
  type: 'llm' | 'tool' | 'generic'
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
  /** Record an LLM step (used by stubs / real adapter) */
  recordLLMStep(step: LLMStep): void
  /** Record a tool call (used by stubs / real adapter) */
  recordToolCall(call: ToolCall): void
}

export interface AITestContext {
  trace: TraceHandle
}

/** Extension points for runner hooks (scaffold for future backend integration) */
export interface RunnerHooks {
  onTestStart?(name: string): void | Promise<void>
  onTestFinish?(name: string, passed: boolean, durationMs: number): void | Promise<void>
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
