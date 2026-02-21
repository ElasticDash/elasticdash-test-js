import chalk from 'chalk'
import type { TestResult, FileResult } from './runner.js'

export function reportResults(fileResults: FileResult[]): void {
  let totalPassed = 0
  let totalFailed = 0
  let totalDurationMs = 0

  for (const fileResult of fileResults) {
    if (fileResults.length > 1) {
      console.log(chalk.dim(`\n${fileResult.file}`))
    }

    for (const result of fileResult.results) {
      printTestResult(result)
      totalDurationMs += result.durationMs
      if (result.passed) {
        totalPassed++
      } else {
        totalFailed++
      }
    }
  }

  printSummary(totalPassed, totalFailed, totalDurationMs)
}

function printTestResult(result: TestResult): void {
  const duration = chalk.dim(`(${formatDuration(result.durationMs)})`)

  if (result.passed) {
    console.log(`  ${chalk.green('✓')} ${result.name} ${duration}`)
  } else {
    console.log(`  ${chalk.red('✗')} ${result.name} ${duration}`)
    if (result.error) {
      const errorLines = formatError(result.error)
      for (const line of errorLines) {
        console.log(`    ${chalk.red('→')} ${line}`)
      }
    }
  }
}

function printSummary(passed: number, failed: number, totalMs: number): void {
  const total = passed + failed
  console.log('')

  if (passed > 0) {
    console.log(chalk.green(`${passed} passed`))
  }
  if (failed > 0) {
    console.log(chalk.red(`${failed} failed`))
  }

  console.log(chalk.dim(`Total: ${total}`))
  console.log(chalk.dim(`Duration: ${formatDuration(totalMs)}`))
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  return `${ms}ms`
}

function formatError(error: Error): string[] {
  const lines: string[] = []
  if (error.message) {
    lines.push(error.message)
  }
  if (error.stack) {
    const stackLines = error.stack
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('at '))
      .slice(0, 3)
    lines.push(...stackLines)
  }
  return lines
}
