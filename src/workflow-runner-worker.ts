/**
 * workflow-runner-worker.ts
 *
 * Subprocess entry point for running a workflow function in an isolated Node.js
 * process with a fresh ESM module cache, guaranteeing that packages with only an
 * "import" exports condition (e.g. jaison) resolve correctly.
 *
 * Protocol (via stdin/stdout):
 *   stdin  — one JSON line:
 *              { workflowsModulePath, toolsModulePath?, workflowName, args, input }
 *   stdout — prefixed result line: __ELASTICDASH_RESULT__:{...json...}
 */

import { startTraceSession, setCurrentTrace } from './trace-adapter/context.js'
import { installAIInterceptor, uninstallAIInterceptor } from './interceptors/ai-interceptor.js'
import type { TraceHandle } from './trace-adapter/context.js'

async function readStdin(): Promise<string> {
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
  }
  return raw
}

const RESULT_PREFIX = '__ELASTICDASH_RESULT__:'

/** Write the result line and wait for the OS to accept the write before returning. */
function writeResult(result: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + '\n', (err) =>
      err ? reject(err) : resolve()
    )
  })
}

/** Minimal inline tool-wrapping — records each tool call to the trace. */
async function loadAndWrapTools(
  toolsModulePath: string,
  trace: TraceHandle,
): Promise<Record<string, (...a: unknown[]) => unknown>> {
  try {
    const toolsMod = await import(toolsModulePath)
    const wrapped: Record<string, (...a: unknown[]) => unknown> = {}
    for (const [name, fn] of Object.entries(toolsMod)) {
      if (typeof fn !== 'function') continue
      wrapped[name] = new Proxy(fn as (...a: unknown[]) => unknown, {
        apply(target, thisArg, args) {
          const result = Reflect.apply(target, thisArg, args)
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            return (result as Promise<unknown>).then((v: unknown) => {
              trace.recordToolCall({ name, args: args.length === 1 ? (args[0] as Record<string, unknown>) : (args as unknown as Record<string, unknown>), result: v })
              return v
            }).catch((e: unknown) => {
              trace.recordToolCall({ name, args: args.length === 1 ? (args[0] as Record<string, unknown>) : (args as unknown as Record<string, unknown>), result: { error: String(e) } })
              throw e
            })
          }
          trace.recordToolCall({ name, args: args.length === 1 ? (args[0] as Record<string, unknown>) : (args as unknown as Record<string, unknown>), result })
          return result
        },
      })
    }
    return wrapped
  } catch {
    return {}
  }
}

async function main() {
  // Keep a reference to the real process.exit so we can call it after flushing stdout.
  const originalExit = process.exit.bind(process)

  const raw = await readStdin()

  let payload: {
    workflowsModulePath: string
    toolsModulePath?: string
    workflowName: string
    args: unknown[]
    input: unknown
  }
  try {
    payload = JSON.parse(raw)
  } catch (e) {
    await writeResult({ ok: false, error: `Invalid JSON input: ${(e as Error).message}` })
    originalExit(1)
    return
  }

  const { workflowsModulePath, toolsModulePath, workflowName, args, input } = payload

  const { context, finalise } = startTraceSession()
  setCurrentTrace(context.trace)

  // Inject wrapped tools into global scope so the workflow can call them
  const globals = global as Record<string, unknown>
  const originalValues: Record<string, unknown> = {}
  let wrappedTools: Record<string, (...a: unknown[]) => unknown> = {}

  if (toolsModulePath) {
    wrappedTools = await loadAndWrapTools(toolsModulePath, context.trace)
    for (const [name, fn] of Object.entries(wrappedTools)) {
      originalValues[name] = globals[name]
      globals[name] = fn
    }
  }

  // Intercept process.exit() so that workflows that call it internally (e.g. agent
  // frameworks that call process.exit(0) after completing) don't kill the subprocess
  // before we write the result.
  let pendingExitCode: number | undefined
  ;(process as NodeJS.Process).exit = (code?: number) => {
    pendingExitCode = code ?? 0
    return undefined as never
  }

  let currentOutput: unknown
  let workflowError: Error | undefined

  try {
    const workflowsMod = await import(workflowsModulePath)
    const workflowFn = workflowsMod[workflowName]
    if (typeof workflowFn !== 'function') {
      ;(process as NodeJS.Process).exit = originalExit
      await writeResult({ ok: false, error: `"${workflowName}" is not an exported function in the workflow module.` })
      originalExit(1)
      return
    }

    installAIInterceptor()
    try {
      const callArgs = args.length > 0 ? args : input !== null && input !== undefined ? [input] : []
      currentOutput = await (workflowFn as (...a: unknown[]) => unknown)(...callArgs)
    } finally {
      uninstallAIInterceptor()
    }
  } catch (e) {
    workflowError = e instanceof Error ? e : new Error(String(e))
  } finally {
    // Restore real process.exit before any further async work
    ;(process as NodeJS.Process).exit = originalExit

    // Restore injected globals
    for (const [name, original] of Object.entries(originalValues)) {
      if (original === undefined) {
        delete globals[name]
      } else {
        globals[name] = original
      }
    }
    setCurrentTrace(undefined)
    finalise()
  }

  const traceData = {
    steps: context.trace.getSteps(),
    llmSteps: context.trace.getLLMSteps(),
    toolCalls: context.trace.getToolCalls(),
    customSteps: context.trace.getCustomSteps(),
  }

  if (workflowError) {
    await writeResult({ ok: false, error: workflowError.message ?? String(workflowError), ...traceData })
    originalExit(pendingExitCode ?? 1)
  } else {
    await writeResult({ ok: true, currentOutput, ...traceData })
    originalExit(pendingExitCode ?? 0)
  }
}

main()
