import { getCaptureContext } from '../capture/recorder.js'

let originalRandom: (() => number) | undefined
let originalDateNow: (() => number) | undefined

/** Call the real Date.now(), bypassing any interception. Safe to call from inside interceptors. */
export function rawDateNow(): number {
  return originalDateNow ? originalDateNow() : Date.now()
}

export function interceptRandom(): void {
  if (originalRandom) return // already installed
  originalRandom = Math.random

  Math.random = (): number => {
    const ctx = getCaptureContext()
    if (!ctx) return originalRandom!()

    const { recorder, replay } = ctx
    const n = recorder.nextSideEffectId()

    if (replay.shouldReplaySideEffectOfType(n, 'Math.random')) {
      return replay.getSideEffectResultOfType(n, 'Math.random') as number
    }

    const value = originalRandom!()
    recorder.record({
      id: n,
      type: 'side_effect',
      name: 'Math.random',
      input: null,
      output: value,
      timestamp: rawDateNow(),
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
    const n = recorder.nextSideEffectId()

    if (replay.shouldReplaySideEffectOfType(n, 'Date.now')) {
      return replay.getSideEffectResultOfType(n, 'Date.now') as number
    }

    const value = originalDateNow!()
    recorder.record({
      id: n,
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
