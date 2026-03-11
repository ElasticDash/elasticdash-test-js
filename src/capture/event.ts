export type WorkflowEventType = 'ai' | 'tool' | 'http' | 'db' | 'side_effect'

export interface WorkflowEvent {
  id: number
  type: WorkflowEventType
  name: string
  input: unknown
  output: unknown
  timestamp: number
  durationMs: number
  /** Optional: ID of the agent task that produced this event */
  agentTaskId?: string
  /** Optional: Zero-based index of the agent task that produced this event */
  agentTaskIndex?: number
}

export interface WorkflowTrace {
  traceId: string
  events: WorkflowEvent[]
}
