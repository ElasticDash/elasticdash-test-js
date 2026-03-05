import { getCaptureContext } from '../capture/recorder.js'

let originalRandom: (() => number) | undefined
let originalDateNow: (() => number) | undefined

export function interceptRandom(): void {
  if (originalRandom) return // already installed
  originalRandom = Math.random

  Math.random = (): number => {
    const ctx = getCaptureContext()
    if (!ctx) return originalRandom!()

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      return replay.getRecordedResult(id) as number
    }

    const value = originalRandom!()
    recorder.record({
      id,
      type: 'side_effect',
      name: 'Math.random',
      input: null,
      output: value,
      timestamp: Date.now(),
      durationMs: 0,
    })

    return value
  }
}

export function restoreRandom(): void {
  if (originalRandom) {
    Math.random = originalRandom
    originalRandom = undefined
  }
}

export function interceptDateNow(): void {
  if (originalDateNow) return // already installed
  originalDateNow = Date.now

  Date.now = (): number => {
    const ctx = getCaptureContext()
    if (!ctx) return originalDateNow!()

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      return replay.getRecordedResult(id) as number
    }

    const value = originalDateNow!()
    recorder.record({
      id,
      type: 'side_effect',
      name: 'Date.now',
      input: null,
      output: value,
      timestamp: value,
      durationMs: 0,
    })

    return value
  }
}

export function restoreDateNow(): void {
  if (originalDateNow) {
    Date.now = originalDateNow
    originalDateNow = undefined
  }
}
