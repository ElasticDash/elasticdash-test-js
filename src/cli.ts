#!/usr/bin/env node
import { Command } from 'commander'
import fg from 'fast-glob'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import { registerMatchers } from './matchers/index.js'
import { runFiles } from './runner.js'
import { reportResults } from './reporter.js'

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
      const mod = await import(pathToFileURL(p).href)
      return (mod.default ?? {}) as ElasticDashConfig
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


  const cwd = process.cwd()
  const config = await loadConfig(cwd)
  const defaultPattern = config.testMatch ?? ['**/*.ai.test.ts', '**/*.ai.test.js']

  // Read version from package.json
  // Use require for CJS compatibility, fallback to import if needed
  // This path is relative to the compiled dist directory
  let version = 'unknown'
  try {
    // @ts-ignore
    version = (await import(pathToFileURL(path.join(cwd, 'package.json')).href, { assert: { type: 'json' } })).default.version
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
    .action(async (dir?: string) => {
      const searchBase = dir ? path.resolve(cwd, dir) : cwd
      const files = await discoverTestFiles(defaultPattern, searchBase)

      if (files.length === 0) {
        console.error(`No test files found matching: ${defaultPattern.join(', ')}`)
        process.exit(1)
      }

      const results = await runFiles(files)
      reportResults(results)

      const anyFailed = results.some((fr) => fr.results.some((r) => !r.passed))
      process.exit(anyFailed ? 1 : 0)
    })

  // elasticdash run <file>
  program
    .command('run <file>')
    .description('Run a single AI test file')
    .action(async (file: string) => {
      const absFile = pathToFileURL(path.resolve(cwd, file)).href

      const results = await runFiles([absFile])
      reportResults(results)

      const anyFailed = results.some((fr) => fr.results.some((r) => !r.passed))
      process.exit(anyFailed ? 1 : 0)
    })

  await program.parseAsync(process.argv)
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
