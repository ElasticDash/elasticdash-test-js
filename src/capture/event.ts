export type WorkflowEventType = 'ai' | 'tool' | 'http' | 'db' | 'side_effect'

export interface WorkflowEvent {
  id: number
  type: WorkflowEventType
  name: string
  input: unknown
  output: unknown
  timestamp: number
  durationMs: number
}

export interface WorkflowTrace {
  traceId: string
  events: WorkflowEvent[]
}
