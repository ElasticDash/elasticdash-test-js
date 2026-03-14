import { TraceRecorder, setCaptureContext } from './capture/recorder.js'
import { ReplayController } from './capture/replay.js'
import { interceptFetch, restoreFetch } from './interceptors/http.js'
import { interceptRandom, restoreRandom, interceptDateNow, restoreDateNow } from './interceptors/side-effects.js'
import type { WorkflowEvent, WorkflowTrace } from './capture/event.js'

export interface RunWorkflowOptions {
  replayMode?: boolean
  checkpoint?: number
  history?: WorkflowEvent[]
  interceptHttp?: boolean
  interceptSideEffects?: boolean
}

export interface WorkflowRunResult<T = unknown> {
  result: T
  trace: WorkflowTrace
}

export async function runWorkflow<T = unknown>(
  workflowFn: () => Promise<T>,
  options: RunWorkflowOptions = {},
): Promise<WorkflowRunResult<T>> {
  const {
    replayMode = false,
    checkpoint = 0,
    history = [],
    interceptHttp = true,
    interceptSideEffects = true,
  } = options

  const recorder = new TraceRecorder()
  const replay = new ReplayController(replayMode, checkpoint, history)

  setCaptureContext({ recorder, replay })

  if (interceptHttp) interceptFetch()
  if (interceptSideEffects) {
    interceptRandom()
    interceptDateNow()
  }

  try {
    const result = await workflowFn()
    await recorder.flush()
    return { result, trace: recorder.toTrace() }
  } finally {
    if (interceptHttp) restoreFetch()
    if (interceptSideEffects) {
      restoreRandom()
      restoreDateNow()
    }
    setCaptureContext(undefined)
  }
}
