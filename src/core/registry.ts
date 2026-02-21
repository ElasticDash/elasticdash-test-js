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

let _registry: Registry = createEmptyRegistry()

function createEmptyRegistry(): Registry {
  return {
    tests: [],
    beforeAllHooks: [],
    afterAllHooks: [],
  }
}

export function clearRegistry(): void {
  _registry = createEmptyRegistry()
}

export function getRegistry(): Registry {
  return _registry
}

export function aiTest(name: string, fn: TestFunction): void {
  _registry.tests.push({ name, fn })
}

export function beforeAll(fn: () => Promise<void> | void): void {
  _registry.beforeAllHooks.push(fn)
}

export function afterAll(fn: () => Promise<void> | void): void {
  _registry.afterAllHooks.push(fn)
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
