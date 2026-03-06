import type { WorkflowEvent } from './event.js'

export class ReplayController {
  private historyMap: Map<number, WorkflowEvent>
  /** Side effects keyed by their assigned sideEffectId, independent of main event IDs */
  private sideEffectMap: Map<number, WorkflowEvent>

  constructor(
    public replayMode: boolean,
    public checkpoint: number,
    public history: WorkflowEvent[],
  ) {
    this.historyMap = new Map(history.map(e => [e.id, e]))
    this.sideEffectMap = new Map(
      history.filter(e => e.type === 'side_effect').map(e => [e.id, e]),
    )
  }

  shouldReplay(eventId: number): boolean {
    return this.replayMode && eventId <= this.checkpoint
  }

  getRecordedEvent(eventId: number): WorkflowEvent | undefined {
    return this.historyMap.get(eventId)
  }

  getRecordedResult(eventId: number): unknown {
    return this.historyMap.get(eventId)?.output
  }

  /** Returns true if the side effect with this sideEffectId has a recorded value to replay */
  shouldReplaySideEffect(n: number): boolean {
    return this.replayMode && this.sideEffectMap.has(n)
  }

  getSideEffectResult(n: number): unknown {
    return this.sideEffectMap.get(n)?.output
  }
}
