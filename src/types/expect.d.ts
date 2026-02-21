import 'expect';
import type { TraceHandle } from '../trace-adapter/context';

interface LLMStepConfig {
  model?: string;
  contains?: string;
}

declare module 'expect' {
  interface Matchers<R> {
    toHaveLLMStep(config?: LLMStepConfig): R;
    toCallTool(toolName: string): R;
    toMatchSemanticOutput(expected: string): R;
  }
}
