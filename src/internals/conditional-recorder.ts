/**
 * Conditional recorder utility for worker contexts
 * 
 * This module provides a safe wrapper around recordToolCall that only executes
 * in worker environments. In non-worker contexts, it's a no-op to avoid unnecessary
 * imports and function calls.
 */

// Check if running in an Elasticdash worker context
const isWorkerContext = (): boolean => {
  if (typeof globalThis === 'undefined') {
    return false;
  }
  return (globalThis as any).__ELASTICDASH_WORKER__ === true;
};

let recordToolCallFn: ((name: string, input: any, output: any) => void) | null = null;

// Lazy load recordToolCall only if in worker context
const getRecordToolCall = async (): Promise<((name: string, input: any, output: any) => void) | null> => {
  if (!isWorkerContext()) {
    return null;
  }

  if (recordToolCallFn !== null) {
    return recordToolCallFn;
  }

  try {
    const { recordToolCall } = await import('../tracing.js');
    recordToolCallFn = recordToolCall;
    return recordToolCallFn;
  } catch (err) {
    console.warn('Failed to load recordToolCall from tracing module:', err);
    return null;
  }
};

/**
 * Safely record a tool call only if in worker context
 * 
 * @param name - Name of the tool/function
 * @param input - Input parameters to the tool
 * @param output - Output/result from the tool
 */
export const safeRecordToolCall = async (
  name: string,
  input: any,
  output: any
): Promise<void> => {
  const recorder = await getRecordToolCall();
  if (recorder) {
    recorder(name, input, output);
  }
};

/**
 * Synchronous version - checks if we're in worker context without importing
 * Use this if you want to avoid async/await in your tool functions
 */
export const isWorker = (): boolean => {
  return isWorkerContext();
};
