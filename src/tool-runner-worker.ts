/**
 * tool-runner-worker.ts
 *
 * Subprocess entry point for running a single tool function in an isolated
 * Node.js process, guaranteeing no stale ESM/tsx module cache.
 *
 * Protocol (via stdin/stdout):
 *   stdin  — one JSON line: { toolsModulePath, toolName, args }
 *   stdout — prefixed result line: __ELASTICDASH_RESULT__:{...json...}
 */

const RESULT_PREFIX = '__ELASTICDASH_RESULT__:'

function writeResult(result: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + '\n', (err) =>
      err ? reject(err) : resolve()
    )
  })
}

async function main() {
  const originalExit = process.exit.bind(process)

  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
  }

  let payload: { toolsModulePath: string; toolName: string; args: unknown[] }
  try {
    payload = JSON.parse(raw)
  } catch (e) {
    await writeResult({ ok: false, error: `Invalid JSON input: ${(e as Error).message}` })
    originalExit(1)
    return
  }

  const { toolsModulePath, toolName, args } = payload

  try {
    const mod = await import(toolsModulePath)
    const fn = mod[toolName]
    if (typeof fn !== 'function') {
      await writeResult({ ok: false, error: `"${toolName}" is not an exported function in the module.` })
      originalExit(1)
      return
    }

    const currentOutput = await fn(...args)
    await writeResult({ ok: true, currentOutput })
    originalExit(0)
  } catch (e) {
    await writeResult({ ok: false, error: (e as Error).message ?? String(e) })
    originalExit(1)
  }
}

main()
