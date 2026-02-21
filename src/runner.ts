import { clearRegistry, getRegistry } from './core/registry.js'
import { startTraceSession } from './trace-adapter/context.js'
import type { RunnerHooks } from './trace-adapter/context.js'

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
  const fileResults: FileResult[] = []

  for (const file of files) {
    const result = await runFile(file, options)
    fileResults.push(result)
  }

  return fileResults
}

async function runFile(file: string, options: RunnerOptions): Promise<FileResult> {
  const { hooks = {} } = options

  // 1. Clear the global registry before loading the file
  clearRegistry()

  // 2. Dynamically import the test file (triggers aiTest() registrations)
  await import(file)

  const registry = getRegistry()
  const results: TestResult[] = []

  // 3. Run beforeAll hooks
  for (const hook of registry.beforeAllHooks) {
    await hook()
  }

  // 4. Execute each test sequentially
  for (const entry of registry.tests) {
    const { context, finalise } = startTraceSession()

    if (hooks.onTestStart) {
      await hooks.onTestStart(entry.name)
    }

    const startTime = Date.now()
    let passed = false
    let error: Error | undefined

    try {
      await entry.fn(context)
      passed = true
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
    }

    const durationMs = Date.now() - startTime

    if (hooks.onTestFinish) {
      await hooks.onTestFinish(entry.name, passed, durationMs)
    }

    if (hooks.onTraceComplete) {
      await hooks.onTraceComplete(entry.name, context.trace)
    }

    finalise()

    results.push({ name: entry.name, passed, durationMs, error })
  }

  // 5. Run afterAll hooks
  for (const hook of registry.afterAllHooks) {
    await hook()
  }

  return { file, results }
}
