// Ensure .env is loaded in the worker subprocess
import 'dotenv/config'
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
import { TraceRecorder, setCaptureContext, getCaptureContext } from './capture/recorder.js'
import { ReplayController } from './capture/replay.js'
import { interceptFetch, restoreFetch } from './interceptors/http.js'
import { interceptRandom, restoreRandom, interceptDateNow, restoreDateNow, rawDateNow } from './interceptors/side-effects.js'
import { installDBAutoInterceptor, uninstallDBAutoInterceptor } from './interceptors/db-auto.js'
import { pathToFileURL } from 'url'
import type { TraceHandle } from './trace-adapter/context.js'
import type { WorkflowEvent } from './capture/event.js'
import type { AgentState } from './types/agent.js'
import fs from 'node:fs'

async function readStdin(): Promise<string> {
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
  }
  return raw.trim()
}


/** Write the result JSON to fd3 pipe and wait for flush. */
function writeResult(result: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const fd = 3
      const json = JSON.stringify(result)
      fs.write(fd, json + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    } catch (e) {
      reject(e)
    }
  })
}

/** Minimal inline tool-wrapping — records each tool call to the trace. */
async function loadAndWrapTools(
  toolsModulePath: string,
  trace: TraceHandle,
): Promise<Record<string, (...a: unknown[]) => unknown>> {
  try {
    // Use absolute file URL for ESM import
    const toolsMod = await import(pathToFileURL(toolsModulePath).href)
    const wrapped: Record<string, (...a: unknown[]) => unknown> = {}
    for (const [name, fn] of Object.entries(toolsMod)) {
      if (typeof fn !== 'function') continue
      wrapped[name] = new Proxy(fn as (...a: unknown[]) => unknown, {
        apply(target, thisArg, args) {
          const recordedArgs = args.length === 1 ? args[0] : args
          const ctx = getCaptureContext()
          const id = ctx ? ctx.recorder.nextId() : -1
          const start = rawDateNow()

          // Replay: return historical result without executing
          if (ctx && ctx.replay.shouldReplay(id)) {
            const historical = ctx.replay.getRecordedEvent(id)
            if (historical) ctx.recorder.record(historical)
            const replayed = ctx.replay.getRecordedResult(id)
            trace.recordToolCall({ name, args: recordedArgs, result: replayed, workflowEventId: id })
            return replayed
          }

          const result = Reflect.apply(target, thisArg, args)
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            return (result as Promise<unknown>).then((v: unknown) => {
              if (ctx) ctx.recorder.record({ id, type: 'tool', name, input: recordedArgs, output: v, timestamp: start, durationMs: rawDateNow() - start })
              trace.recordToolCall({ name, args: recordedArgs, result: v, workflowEventId: id })
              return v
            }).catch((e: unknown) => {
              if (ctx) ctx.recorder.record({ id, type: 'tool', name, input: recordedArgs, output: { error: String(e) }, timestamp: start, durationMs: rawDateNow() - start })
              trace.recordToolCall({ name, args: recordedArgs, result: { error: String(e) }, workflowEventId: id })
              throw e
            })
          }
          if (ctx) ctx.recorder.record({ id, type: 'tool', name, input: recordedArgs, output: result, timestamp: start, durationMs: rawDateNow() - start })
          trace.recordToolCall({ name, args: recordedArgs, result, workflowEventId: id })
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
    replayMode?: boolean
    checkpoint?: number
    history?: WorkflowEvent[]
    /** Optional agent state for mid-trace agent resumption */
    agentState?: AgentState
  }
  try {
    payload = JSON.parse(raw)
  } catch (e) {
    await writeResult({ ok: false, error: `Invalid JSON input: ${(e as Error).message}` })
    originalExit(1)
    return
  }

  const { workflowsModulePath, toolsModulePath, workflowName, args, input, replayMode = false, checkpoint = 0, history = [], agentState } = payload

  const { context, finalise } = startTraceSession()
  setCurrentTrace(context.trace)

  const recorder = new TraceRecorder()
  const replay = new ReplayController(replayMode, checkpoint, history)
  setCaptureContext({ recorder, replay })

  // Inject wrapped tools into global scope so the workflow can call them
  // NOTE: This only works if the workflow accesses tools as globals, not via import.
  // If the workflow uses import { tool } from './tools', the injected global will NOT be used.
  // For maximum robustness, prefer passing tools as explicit arguments or context.
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
  // WARNING: This only intercepts process.exit() in this scope. Libraries that cache their own reference to process.exit may still terminate the process.
  let pendingExitCode: number | undefined
  ;(process as NodeJS.Process).exit = (code?: number) => {
    pendingExitCode = code ?? 0
    return undefined as never
  }

  let currentOutput: unknown
  let workflowError: Error | undefined

  try {
    await installDBAutoInterceptor()
    installAIInterceptor()
    interceptFetch()
    interceptRandom()
    interceptDateNow()

    try {
      if (agentState) {
        // Agent mid-trace resumption path: load ed_agents and resume from saved state
        const agentsModulePath = workflowsModulePath.replace(/ed_workflows(\.[^.]+)?$/, 'ed_agents$1')
        const agentsMod = await import(pathToFileURL(agentsModulePath).href)
        if (typeof agentsMod.resumeAgentFromTrace !== 'function') {
          throw new Error(`"resumeAgentFromTrace" is not an exported function in ${agentsModulePath}`)
        }
        currentOutput = await (agentsMod.resumeAgentFromTrace as (s: AgentState) => Promise<unknown>)(agentState)
        console.error('[worker] resumeAgentFromTrace resolved, currentOutput:', currentOutput)
      } else {
        // Standard workflow path
        const workflowsMod = await import(pathToFileURL(workflowsModulePath).href)
        const workflowFn = workflowsMod[workflowName]
        if (typeof workflowFn !== 'function') {
          ;(process as NodeJS.Process).exit = originalExit
          await writeResult({ ok: false, error: `"${workflowName}" is not an exported function in the workflow module.` })
          originalExit(1)
          return
        }
        // Standardize workflow argument resolution: always pass [input] if args is empty
        const callArgs = args.length ? args : [input]
        currentOutput = await (workflowFn as (...a: unknown[]) => unknown)(...callArgs)
        console.error('[worker] workflowFn resolved, currentOutput:', currentOutput)  // stderr so it's visible
      }
    } finally {
      uninstallAIInterceptor()
      restoreFetch()
      restoreRandom()
      restoreDateNow()
      uninstallDBAutoInterceptor()
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
    setCaptureContext(undefined)
    finalise()
  }

  const traceData = {
    steps: context.trace.getSteps(),
    llmSteps: context.trace.getLLMSteps(),
    toolCalls: context.trace.getToolCalls(),
    customSteps: context.trace.getCustomSteps(),
    workflowTrace: recorder.toTrace(),
  }

  if (workflowError) {
    await writeResult({ ok: false, error: workflowError.message ?? String(workflowError), ...traceData })
    originalExit(pendingExitCode ?? 1)
  } else {
    await writeResult({ ok: true, currentOutput, ...traceData })
    originalExit(pendingExitCode ?? 0)
  }
}


main().catch((err) => {
  // Write error to fd3 and exit
  try {
    fs.write(3, JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }) + '\n', () => {
      process.exit(1);
    });
  } catch (e) {
    process.exit(1);
  }
});
