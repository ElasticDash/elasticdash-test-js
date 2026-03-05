import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { WorkflowEvent, WorkflowTrace } from './event.js'
import type { ReplayController } from './replay.js'

export class TraceRecorder {
  events: WorkflowEvent[] = []
  private _counter = 0

  record(event: WorkflowEvent): void {
    this.events.push(event)
  }

  nextId(): number {
    return ++this._counter
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
