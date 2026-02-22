/**
 * Import this file in your AI test files to get:
 *   - aiTest / beforeAll / afterAll / beforeEach / afterEach available as globals (TypeScript types + runtime)
 *   - Custom matcher types (toHaveLLMStep, toCallTool, toMatchSemanticOutput)
 *
 * The CLI registers matchers at startup, so this import is for TypeScript
 * type awareness only — no double-registration occurs at runtime.
 */

// Side-effect: populates globalThis.aiTest + brings declare global into scope
import './core/registry.js'

// Side-effect: brings declare module 'expect' augmentation into scope
import './matchers/index.js'

export {}
