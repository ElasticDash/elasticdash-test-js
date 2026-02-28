#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import fg from 'fast-glob'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import { registerMatchers } from './matchers/index.js'
import { installAIInterceptor } from './interceptors/ai-interceptor.js'
import { runFiles } from './runner.js'
import { reportResults } from './reporter.js'
import { startBrowserUiServer, type UiEvent } from './browser-ui.js'
import { startDashboardServer } from './dashboard-server.js'

function stripAnsi(input?: string): string | undefined {
  if (!input) return input
  return input.replace(/\u001b\[[0-9;]*m/g, '')
}

// --- Config loading (optional) ---
interface ElasticDashConfig {
  testMatch?: string[]
  traceMode?: 'local' | 'remote'
}

async function loadConfig(cwd: string): Promise<ElasticDashConfig> {
  const configPath = path.join(cwd, 'elasticdash.config.ts')
  const configPathJs = path.join(cwd, 'elasticdash.config.js')

  for (const p of [configPath, configPathJs]) {
    if (existsSync(p)) {
      try {
        const mod = await import(pathToFileURL(p).href)
        return (mod.default ?? {}) as ElasticDashConfig
      } catch (error) {
        // Skip this config file if it can't be imported (e.g., .ts when running from built dist)
        continue
      }
    }
  }
  return {}
}

// --- File discovery ---
async function discoverTestFiles(patterns: string[], cwd: string): Promise<string[]> {
  const files = await fg(patterns, { cwd, absolute: true })
  return files.sort()
}

// --- Bootstrap ---
async function bootstrap(): Promise<void> {

  registerMatchers()
  installAIInterceptor()

  const cwd = process.cwd()
  const config = await loadConfig(cwd)
  const defaultPattern = config.testMatch ?? ['**/*.ai.test.ts', '**/*.ai.test.js']

  // Read version from package.json
  // Use require for CJS compatibility, fallback to import if needed
  // This path is relative to the compiled dist directory
  let version = 'unknown'
  try {
    // @ts-ignore
    version = (await import(pathToFileURL(path.join(cwd, 'package.json')).href, { with: { type: 'json' } })).default.version
  } catch (e) {
    try {
      version = require(path.join(cwd, 'package.json')).version
    } catch {}
  }


  const program = new Command()

  program
    .name('elasticdash')
    .description('AI-native test runner for ElasticDash workflow testing')
    .version(version)

  // elasticdash test [dir]
  program
    .command('test [dir]')
    .description('Discover and run all AI test files')
    .option('--no-browser-ui', 'Disable browser progress UI')
    .option('--browser-ui-port <port>', 'Port for browser UI', (v) => Number(v), undefined)
    .action(async (dir?: string, cmd?: any) => {
      const searchBase = dir ? path.resolve(cwd, dir) : cwd
      console.log('[elasticdash] Test discovery pattern:', defaultPattern)
      console.log('[elasticdash] Test search base:', searchBase)
      const files = await discoverTestFiles(defaultPattern, searchBase)
      console.log('[elasticdash] Discovered test files:', files)

      if (files.length === 0) {
        console.error(`No test files found matching: ${defaultPattern.join(', ')}`)
        process.exit(1)
      }

      const useBrowserUiEnv = process.env.ELASTICDASH_BROWSER_UI !== '0'
      const useBrowserUiFlag = cmd?.browserUi !== false
      const enableBrowserUi = useBrowserUiEnv && useBrowserUiFlag

      const ui = enableBrowserUi
        ? await startBrowserUiServer({ port: cmd?.browserUiPort, autoOpen: true })
        : undefined

      if (ui) {
        ui.send({ type: 'run-start', payload: { files } })
      }

      const startedAt = Date.now()

      const results = await runFiles(files, {
        hooks: {
          onTestStart(name) {
            ui?.send({ type: 'test-start', payload: { name } })
          },
          onTestFinish(name, passed, durationMs, error) {
            ui?.send({
              type: 'test-finish',
              payload: { name, passed, durationMs, errorMessage: stripAnsi(error?.message) },
            })
          },
        },
      })

      // Log registered tests
      const { getRegistry } = await import('./core/registry.js')
      const registry = getRegistry()
      console.log('[elasticdash] Tests registered:', registry.tests.map(t => t.name))
      reportResults(results)

      const anyFailed = results.some((fr) => fr.results.some((r) => !r.passed))

      let uiDelayMs = 0
      if (ui) {
        const durationMs = Date.now() - startedAt
        const failures: Array<{ name: string; errorMessage?: string }> = []
        let totalTests = 0
        let passedCount = 0
        for (const fr of results) {
          for (const r of fr.results) {
            totalTests += 1
            if (r.passed) passedCount += 1
            else failures.push({ name: r.name, errorMessage: stripAnsi(r.error?.message) })
          }
        }
        ui.send({
          type: 'run-summary',
          payload: {
            passed: passedCount,
            failed: failures.length,
            total: totalTests,
            durationMs,
            failures,
          },
        })
        uiDelayMs = 60000
      }

      if (uiDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, uiDelayMs))
        ui?.close()
      }

      process.exit(anyFailed ? 1 : 0)
    })

  // elasticdash run <file>
  program
    .command('run <file>')
    .description('Run a single AI test file')
    .option('--no-browser-ui', 'Disable browser progress UI')
    .option('--browser-ui-port <port>', 'Port for browser UI', (v) => Number(v), undefined)
    .action(async (file: string, cmd?: any) => {
      const absFile = pathToFileURL(path.resolve(cwd, file)).href

      const useBrowserUiEnv = process.env.ELASTICDASH_BROWSER_UI !== '0'
      const useBrowserUiFlag = cmd?.browserUi !== false
      const enableBrowserUi = useBrowserUiEnv && useBrowserUiFlag
      const ui = enableBrowserUi
        ? await startBrowserUiServer({ port: cmd?.browserUiPort, autoOpen: true })
        : undefined

      if (ui) {
        ui.send({ type: 'run-start', payload: { files: [absFile] } })
      }

      const startedAt = Date.now()

      const results = await runFiles([absFile], {
        hooks: {
          onTestStart(name) {
            ui?.send({ type: 'test-start', payload: { name } })
          },
          onTestFinish(name, passed, durationMs, error) {
            ui?.send({
              type: 'test-finish',
              payload: { name, passed, durationMs, errorMessage: stripAnsi(error?.message) },
            })
          },
        },
      })
      reportResults(results)

      const anyFailed = results.some((fr) => fr.results.some((r) => !r.passed))
      let uiDelayMs = 0
      if (ui) {
        const durationMs = Date.now() - startedAt
        const failures: Array<{ name: string; errorMessage?: string }> = []
        let totalTests = 0
        let passedCount = 0
        for (const fr of results) {
          for (const r of fr.results) {
            totalTests += 1
            if (r.passed) passedCount += 1
            else failures.push({ name: r.name, errorMessage: stripAnsi(r.error?.message) })
          }
        }
        ui.send({
          type: 'run-summary',
          payload: {
            passed: passedCount,
            failed: failures.length,
            total: totalTests,
            durationMs,
            failures,
          },
        })
        uiDelayMs = 60000
      }

      if (uiDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, uiDelayMs))
        ui?.close()
      }

      process.exit(anyFailed ? 1 : 0)
    })

  // elasticdash dashboard
  program
    .command('dashboard')
    .description('Browse and search workflow functions')
    .option('--port <port>', 'Dashboard server port', (v) => Number(v), 4573)
    .option('--no-open', 'Skip auto-opening browser')
    .action(async (options: { port: number; open: boolean }) => {
      console.log('[elasticdash] Starting dashboard server...')
      
      const server = await startDashboardServer(cwd, {
        port: options.port,
        autoOpen: options.open,
      })
      
      console.log(`[elasticdash] Dashboard running at ${server.url}`)
      console.log('[elasticdash] Press Ctrl+C to stop')
      
      // Keep the process running with proper cleanup
      let isShuttingDown = false
      
      const cleanup = async () => {
        if (isShuttingDown) {
          // Force exit on second Ctrl+C
          console.log('\n[elasticdash] Force exiting...')
          process.exit(1)
        }
        
        isShuttingDown = true
        console.log('\n[elasticdash] Shutting down dashboard server...')
        
        try {
          await Promise.race([
            server.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
          ])
          process.exit(0)
        } catch (error) {
          console.error('[elasticdash] Error during shutdown:', error)
          process.exit(1)
        }
      }
      
      process.once('SIGINT', cleanup)
      process.once('SIGTERM', cleanup)
    })

  await program.parseAsync(process.argv)
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
