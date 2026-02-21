import type { AITestContext } from '../trace-adapter/context.js'

export type TestFunction = (ctx: AITestContext) => Promise<void> | void

export interface TestEntry {
  name: string
  fn: TestFunction
}

export interface Registry {
  tests: TestEntry[]
  beforeAllHooks: Array<() => Promise<void> | void>
  afterAllHooks: Array<() => Promise<void> | void>
}

const REGISTRY_KEY = '__elasticdash_registry__'

function getGlobalRegistry(): Registry {
  if (!(globalThis as any)[REGISTRY_KEY]) {
    (globalThis as any)[REGISTRY_KEY] = createEmptyRegistry()
  }
  return (globalThis as any)[REGISTRY_KEY] as Registry
}

function createEmptyRegistry(): Registry {
  return {
    tests: [],
    beforeAllHooks: [],
    afterAllHooks: [],
  }
}

export function clearRegistry(): void {
  (globalThis as any)[REGISTRY_KEY] = createEmptyRegistry()
  console.log('[elasticdash] clearRegistry called. Registry reset.')
}

export function getRegistry(): Registry {
  const registry = getGlobalRegistry()
  console.log('[elasticdash] getRegistry called. Current tests:', registry.tests.map(t => t.name))
  return registry
}

export function aiTest(name: string, fn: TestFunction): void {
  const registry = getGlobalRegistry()
  registry.tests.push({ name, fn })
  console.log(`[elasticdash] Registered test: ${name}`)
}

export function beforeAll(fn: () => Promise<void> | void): void {
  const registry = getGlobalRegistry()
  registry.beforeAllHooks.push(fn)
}

export function afterAll(fn: () => Promise<void> | void): void {
  const registry = getGlobalRegistry()
  registry.afterAllHooks.push(fn)
}

// Expose globally so test files can use without importing
declare global {
  // eslint-disable-next-line no-var
  var aiTest: (name: string, fn: TestFunction) => void
  // eslint-disable-next-line no-var
  var beforeAll: (fn: () => Promise<void> | void) => void
  // eslint-disable-next-line no-var
  var afterAll: (fn: () => Promise<void> | void) => void
}

globalThis.aiTest = aiTest
globalThis.beforeAll = beforeAll
globalThis.afterAll = afterAll
