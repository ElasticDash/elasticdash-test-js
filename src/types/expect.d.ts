import 'expect';
import type { TraceHandle } from '../trace-adapter/context';

interface LLMStepConfig {
  model?: string
  contains?: string        // searches prompt + completion
  promptContains?: string  // searches only in step.prompt
  outputContains?: string  // searches only in step.completion
  provider?: string        // 'openai' | 'gemini' | 'grok'
}

declare module 'expect' {
  interface Matchers<R> {
    toHaveLLMStep(config?: LLMStepConfig): R;
    toCallTool(toolName: string): R;
    toMatchSemanticOutput(expected: string): R;
  }
}
