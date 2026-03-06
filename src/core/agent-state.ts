/**
 * Agent state serialization, deserialization, and utility functions.
 *
 * Enables capturing agent plan state during execution and resuming
 * agents from any task in the plan without re-executing completed steps.
 */

import type { AgentPlan, AgentState, AgentTask } from '../types/agent.js'
import type { WorkflowEvent } from '../capture/event.js'

/**
 * Serializes an agent plan and its captured trace events into an AgentState
 * that can be persisted and later used for resumption.
 *
 * The resumeFromTaskIndex is automatically determined as the index of the
 * first non-completed task. If all tasks are completed, it equals tasks.length.
 */
export function serializeAgentState(plan: AgentPlan, trace: WorkflowEvent[]): AgentState {
  const resumeFromTaskIndex = plan.tasks.findIndex(
    (t) => t.status !== 'completed',
  )
  return {
    plan: JSON.parse(JSON.stringify(plan)) as AgentPlan,
    trace: JSON.parse(JSON.stringify(trace)) as WorkflowEvent[],
    resumeFromTaskIndex: resumeFromTaskIndex === -1 ? plan.tasks.length : resumeFromTaskIndex,
  }
}

/**
 * Validates and hydrates an AgentState from a parsed JSON object.
 * Throws if the state is invalid or cannot be safely used for resumption.
 */
export function deserializeAgentState(raw: unknown): AgentState {
  if (!raw || typeof raw !== 'object') {
    throw new Error('AgentState must be a non-null object')
  }
  const obj = raw as Record<string, unknown>

  if (!obj.plan || typeof obj.plan !== 'object') {
    throw new Error('AgentState.plan is required')
  }
  const plan = obj.plan as AgentPlan

  if (!Array.isArray(plan.tasks)) {
    throw new Error('AgentState.plan.tasks must be an array')
  }
  if (typeof plan.id !== 'string') {
    throw new Error('AgentState.plan.id must be a string')
  }

  const trace = Array.isArray(obj.trace) ? (obj.trace as WorkflowEvent[]) : []
  const resumeFromTaskIndex =
    typeof obj.resumeFromTaskIndex === 'number' ? obj.resumeFromTaskIndex : 0

  // Validate that all tasks before resumeFromTaskIndex have outputs
  for (let i = 0; i < resumeFromTaskIndex; i++) {
    const task = plan.tasks[i]
    if (!task) continue
    if (task.status !== 'completed') {
      throw new Error(
        `Task at index ${i} (id="${task.id}") has status "${task.status}" but must be "completed" before resumeFromTaskIndex=${resumeFromTaskIndex}`,
      )
    }
    if (task.output === undefined) {
      throw new Error(
        `Task at index ${i} (id="${task.id}") is completed but has no output. Cannot resume safely.`,
      )
    }
  }

  return { plan, trace, resumeFromTaskIndex }
}

/**
 * Extracts all completed task outputs into a flat map keyed by task ID.
 * Used for resolving placeholder references in subsequent task inputs.
 */
export function extractTaskOutputs(plan: AgentPlan): Record<string, unknown> {
  const outputs: Record<string, unknown> = {}
  for (const task of plan.tasks) {
    if (task.status === 'completed' && task.output !== undefined) {
      outputs[task.id] = task.output
    }
  }
  return outputs
}

/**
 * Resolves placeholder references in a task input.
 *
 * Placeholders use the form: `{ $ref: "task-N.output.fieldName" }`
 * where "task-N" is a task ID and "fieldName" is a dot-separated path
 * into that task's output.
 *
 * Example:
 *   previousOutputs = { "task-1": { userId: "abc" } }
 *   input = { $ref: "task-1.output.userId" }
 *   → returns "abc"
 *
 * Works recursively on nested objects and arrays.
 */
export function resolveTaskInput(
  input: unknown,
  previousOutputs: Record<string, unknown>,
): unknown {
  if (input === null || input === undefined) return input

  if (Array.isArray(input)) {
    return input.map((item) => resolveTaskInput(item, previousOutputs))
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>

    // Check for placeholder: { $ref: "taskId.output.path" }
    if (typeof obj['$ref'] === 'string') {
      return resolveRef(obj['$ref'], previousOutputs)
    }

    // Recursively resolve nested objects
    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      resolved[k] = resolveTaskInput(v, previousOutputs)
    }
    return resolved
  }

  return input
}

/**
 * Resolves a dot-separated reference path like "task-1.output.userId"
 * against the previousOutputs map.
 */
function resolveRef(ref: string, previousOutputs: Record<string, unknown>): unknown {
  const parts = ref.split('.')
  // Expected format: <taskId>.output.<...path>
  // We skip the literal "output" segment to navigate into the output object
  const taskId = parts[0]
  const pathParts = parts.slice(1) // may start with "output"

  let current: unknown = previousOutputs[taskId]
  for (const part of pathParts) {
    if (part === 'output') continue // "output" is implicit — skip this keyword
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Clones a task and marks it as completed with the given output.
 * Used internally when skipping already-completed tasks during resumption.
 */
export function markTaskCompleted(task: AgentTask, output: unknown): AgentTask {
  return {
    ...task,
    status: 'completed',
    output,
    completedAt: task.completedAt ?? Date.now(),
  }
}
