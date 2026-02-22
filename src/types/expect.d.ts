import 'expect';
import type { TraceHandle, CustomStep, CustomStepKind } from '../trace-adapter/context';

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

declare module 'expect' {
  interface Matchers<R> {
    toHaveLLMStep(config?: LLMStepConfig): R;
    toCallTool(toolName: string): R;
    toMatchSemanticOutput(expected: string, options?: SemanticMatchOptions): R;
    toHaveCustomStep(config?: CustomStepConfig): R;
    toHavePromptWhere(config: PromptWhereConfig): R;
    toEvaluateOutputMetric(config: EvaluateOutputMetricConfig): Promise<R>;
  }
}
