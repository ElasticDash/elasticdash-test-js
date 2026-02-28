import { clearRegistry, getRegistry } from './core/registry.js'
import { startTraceSession, setCurrentTrace } from './trace-adapter/context.js'
import { startLLMProxy, fetchCapturedTrace } from './proxy/llm-capture.js'
import type { RunnerHooks } from './trace-adapter/context.js'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface TestResult {
  name: string
  passed: boolean
  durationMs: number
  error?: Error
}

export interface FileResult {
  file: string
  results: TestResult[]
}

export interface RunnerOptions {
  hooks?: RunnerHooks
}

export async function runFiles(files: string[], options: RunnerOptions = {}): Promise<FileResult[]> {
  // Optional local LLM capture proxy (opt-in via env). Default behavior stays unchanged when disabled.
  const proxyOptIn = process.env.ELASTICDASH_LLM_PROXY === '1' || Boolean(process.env.ELASTICDASH_LLM_PROXY_URL)
  const proxyPort = Number.parseInt(process.env.ELASTICDASH_LLM_PROXY_PORT || '8787', 10)
  let proxyUrl = process.env.ELASTICDASH_LLM_PROXY_URL
  const proxyHandle = proxyOptIn && !proxyUrl ? await startLLMProxy({ port: proxyPort }) : null
  if (proxyHandle) {
    proxyUrl = proxyHandle.url
  }

  const fileResults: FileResult[] = []

  for (const file of files) {
    const result = await runFile(file, options, { proxyOptIn, proxyUrl })
    fileResults.push(result)
  }

  if (proxyHandle) {
    await proxyHandle.stop()
  }

  return fileResults
}

async function runFile(file: string, options: RunnerOptions, proxyCtx: { proxyOptIn: boolean; proxyUrl: string | null | undefined }): Promise<FileResult> {
  const { hooks = {} } = options

  // 1. Clear the global registry before loading the file
  clearRegistry()

  // 2. Dynamically import the test file (triggers aiTest() registrations)
  const resolvedPath = file.startsWith('file://')
    ? file
    : pathToFileURL(path.resolve(file)).href

  if (resolvedPath.endsWith('.ts') && typeof (globalThis as any).Deno === 'undefined') {
    await import('tsx/esm')
    await import('tsx/cjs')
  }

  await import(resolvedPath)

  const registry = getRegistry()
  const results: TestResult[] = []

  // Shared unhandled error trap for this file's test run
  let currentTestName: string | null = null
  let pendingUnhandled: Error | undefined
  const onUnhandled = (reason: unknown) => {
    if (!pendingUnhandled) pendingUnhandled = reason instanceof Error ? reason : new Error(String(reason))
  }
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUnhandled)

  // 3. Run beforeAll hooks
  for (const hook of registry.beforeAllHooks) {
    await hook()
  }

  // 4. Execute each test sequentially
  for (const entry of registry.tests) {
    const { context, finalise } = startTraceSession()
    const traceId = proxyCtx.proxyOptIn ? randomUUID() : null
    setCurrentTrace(context.trace)
    if (traceId) {
      process.env.ELASTICDASH_TRACE_ID = traceId
    }

    if (hooks.onTestStart) {
      await hooks.onTestStart(entry.name)
    }

    const startTime = Date.now()
    let passed = false
    let error: Error | undefined

    // Reset per-test unhandled capture and mark current test name
    pendingUnhandled = undefined
    currentTestName = entry.name

    setCurrentTrace(context.trace)
    try {
      for (const hook of registry.beforeEachHooks) {
        await hook()
      }

      await entry.fn(context)
      passed = true
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
    } finally {
      try {
        for (const hook of registry.afterEachHooks) {
          await hook()
        }
      } catch (afterErr) {
        if (!error) {
          error = afterErr instanceof Error ? afterErr : new Error(String(afterErr))
          passed = false
        }
      }

      setCurrentTrace(undefined)
      if (!error && pendingUnhandled) {
        error = pendingUnhandled
        passed = false
      }
      currentTestName = null
    }

    const durationMs = Date.now() - startTime

    if (hooks.onTestFinish) {
      await hooks.onTestFinish(entry.name, passed, durationMs, error)
    }

    if (hooks.onTraceComplete) {
      await hooks.onTraceComplete(entry.name, context.trace)
    }

    // If proxy mode is enabled, pull captured LLM steps and fold into the trace
    if (traceId && proxyCtx.proxyUrl) {
      try {
        const captured = await fetchCapturedTrace(proxyCtx.proxyUrl, traceId)
        for (const step of captured) {
          context.trace.recordLLMStep(step)
        }
      } catch (proxyErr) {
        // Non-fatal: keep test result as-is
        // eslint-disable-next-line no-console
        console.warn('[elasticdash] Failed to fetch proxy-captured steps:', proxyErr)
      }
    }

    finalise()
    setCurrentTrace(undefined)
    if (traceId) {
      delete process.env.ELASTICDASH_TRACE_ID
    }

    results.push({ name: entry.name, passed, durationMs, error })
  }

  // 5. Run afterAll hooks
  for (const hook of registry.afterAllHooks) {
    await hook()
  }

  // Cleanup shared handlers
  process.off('unhandledRejection', onUnhandled)
  process.off('uncaughtException', onUnhandled)

  return { file, results }
}
