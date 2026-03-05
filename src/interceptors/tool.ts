import { getCaptureContext } from '../capture/recorder.js'

export function wrapTool<Args extends unknown[], R>(
  name: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const ctx = getCaptureContext()
    if (!ctx) return fn(...args)

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      return replay.getRecordedResult(id) as R
    }

    const start = Date.now()
    const output = await fn(...args)
    recorder.record({
      id,
      type: 'tool',
      name,
      input: args.length === 1 ? args[0] : args,
      output,
      timestamp: start,
      durationMs: Date.now() - start,
    })

    return output
  }
}
