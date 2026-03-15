import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { WorkflowEvent, WorkflowTrace } from './event.js'
import type { ReplayController } from './replay.js'

export class TraceRecorder {
  events: WorkflowEvent[] = []
  private _counter = 0
  private _sideEffectCounter = 0
  private _pending: Set<Promise<void>> = new Set()

  record(event: WorkflowEvent): void {
    this.events.push(event)
  }

  /** Register an in-flight async recording promise so flush() can await it. */
  trackAsync(promise: Promise<void>): void {
    this._pending.add(promise)
    promise.finally(() => { this._pending.delete(promise) })
  }

  /** Await all in-flight async recordings. No-op when none are pending. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this._pending])
  }

  nextId(): number {
    return ++this._counter
  }

  /** Separate counter for Date.now / Math.random — never shares IDs with main events. */
  nextSideEffectId(): number {
    return ++this._sideEffectCounter
  }

  toTrace(traceId?: string): WorkflowTrace {
    return {
      traceId: traceId ?? randomUUID(),
      events: [...this.events],
    }
  }
}

export interface CaptureContext {
  recorder: TraceRecorder
  replay: ReplayController
}

const g = globalThis as Record<string, unknown>
const CAPTURE_ALS_KEY = '__elasticdash_capture_als__'
const captureAls: AsyncLocalStorage<CaptureContext | undefined> =
  (g[CAPTURE_ALS_KEY] as AsyncLocalStorage<CaptureContext | undefined>) ??
  new AsyncLocalStorage<CaptureContext | undefined>()
if (!g[CAPTURE_ALS_KEY]) g[CAPTURE_ALS_KEY] = captureAls

export function setCaptureContext(ctx: CaptureContext | undefined): void {
  captureAls.enterWith(ctx)
}

export function getCaptureContext(): CaptureContext | undefined {
  return captureAls.getStore()
}
