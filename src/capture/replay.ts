import type { WorkflowEvent } from './event.js'

export class ReplayController {
  constructor(
    public replayMode: boolean,
    public checkpoint: number,
    public history: WorkflowEvent[],
  ) {}

  shouldReplay(eventId: number): boolean {
    return this.replayMode && eventId <= this.checkpoint
  }

  getRecordedEvent(eventId: number): WorkflowEvent | undefined {
    return this.history[eventId - 1]
  }

  getRecordedResult(eventId: number): unknown {
    return this.history[eventId - 1]?.output
  }
}
