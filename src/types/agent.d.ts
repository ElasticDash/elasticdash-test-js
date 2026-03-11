/**
 * Agent state type definitions for mid-trace replay support.
 *
 * These types enable structured plan/task management for agents, allowing
 * them to be resumed from any task in the plan without re-executing
 * already-completed steps.
 */

export type AgentTaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed'

export interface AgentTask {
  /** Unique task identifier (e.g. "task-1", "task-2") */
  id: string
  /** Current execution status */
  status: AgentTaskStatus
  /** Human-readable description of what this task does */
  description: string
  /** Tool/service to invoke (e.g. 'apiService', 'queryRefinement') */
  tool: string
  /**
   * Task input parameters. May contain placeholder references to previous
   * task outputs using the syntax: { $ref: "task-N.output.fieldName" }
   */
  input: unknown
  /** Task result, populated after successful execution */
  output?: unknown
  /** Error message if task failed */
  error?: string
  /** Unix timestamp when task execution started */
  startedAt?: number
  /** Unix timestamp when task execution completed */
  completedAt?: number
}

export type AgentPlanStatus = 'planning' | 'executing' | 'completed' | 'failed' | 'paused'

export interface AgentPlan {
  /** Unique plan identifier */
  id: string
  /** Ordered list of tasks to execute */
  tasks: AgentTask[]
  /** Overall plan execution status */
  status: AgentPlanStatus
  /** Zero-based index of the task currently being executed */
  currentTaskIndex: number
  /** Shared data/variables accessible to all tasks */
  context: Record<string, unknown>
  /** Additional plan metadata (user query, session ID, etc.) */
  metadata: Record<string, unknown>
}

export interface AgentState {
  /** The full agent plan including completed and pending tasks */
  plan: AgentPlan
  /** Partial trace events captured during previous execution */
  trace: import('../capture/event.js').WorkflowEvent[]
  /**
   * Zero-based index of the task to resume from.
   * Tasks 0..(resumeFromTaskIndex-1) will use cached outputs from plan.tasks.
   * Tasks resumeFromTaskIndex..end will be executed fresh.
   */
  resumeFromTaskIndex: number
}
