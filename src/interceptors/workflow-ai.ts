import { getCaptureContext } from '../capture/recorder.js'

export function wrapAI<Args extends unknown[], R>(
  modelName: string,
  callFn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const ctx = getCaptureContext()
    if (!ctx) return callFn(...args)

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      return replay.getRecordedResult(id) as R
    }

    const start = Date.now()
    const output = await callFn(...args)
    recorder.record({
      id,
      type: 'ai',
      name: modelName,
      input: args.length === 1 ? args[0] : args,
      output,
      timestamp: start,
      durationMs: Date.now() - start,
    })

    return output
  }
}
