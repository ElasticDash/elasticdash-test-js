/**
 * ed_agents.ts
 *
 * Agent functions for structured plan/task execution with mid-trace resumption
 * support. Agents operate on an explicit AgentPlan, making it possible to:
 *   - Serialize state after any task
 *   - Resume execution from any task without re-running completed steps
 *   - Replay side-effects deterministically using the existing trace infrastructure
 *
 * Usage:
 *   1. Generate a plan:       const plan = await plannerAgent(userQuery, context)
 *   2. Execute the plan:      const result = await executorAgent(plan)
 *   3. Save state:            const state = serializeAgentState(result, traceEvents)
 *   4. Resume later:          const resumed = await resumeAgentFromTrace(state)
 */

import { randomUUID } from 'node:crypto'
import type { AgentPlan, AgentState, AgentTask } from './src/types/agent.js'
import {
  deserializeAgentState,
  extractTaskOutputs,
  resolveTaskInput,
} from './src/core/agent-state.js'
import { getCaptureContext } from './src/capture/recorder.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Tags all events recorded from `startId` onwards with the given agent task
 * context. Called after each task completes so the dashboard can group events
 * by task boundary.
 */
function tagRecentEvents(taskId: string, taskIndex: number, startId: number): void {
  const ctx = getCaptureContext()
  if (!ctx) return
  for (const event of ctx.recorder.events) {
    if (event.id >= startId) {
      event.agentTaskId = taskId
      event.agentTaskIndex = taskIndex
    }
  }
}

/**
 * Returns the highest event ID currently recorded (or 0 if none).
 * Used to identify events generated during a specific task's execution.
 */
function currentMaxEventId(): number {
  const ctx = getCaptureContext()
  if (!ctx || ctx.recorder.events.length === 0) return 0
  return ctx.recorder.events[ctx.recorder.events.length - 1].id
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/** All tools available to agents. Populated lazily from ed_tools.ts exports. */
let _toolRegistry: Record<string, (input: unknown) => Promise<unknown>> | null = null

async function getToolRegistry(): Promise<Record<string, (input: unknown) => Promise<unknown>>> {
  if (_toolRegistry) return _toolRegistry

  // In the worker subprocess, tools are injected as globals by workflow-runner-worker.ts.
  // We prefer those (already wrapped with replay support) over the raw module imports.
  const g = globalThis as Record<string, unknown>
  const toolNames = [
    'apiService',
    'queryRefinement',
    'dataService',
    'pokemonService',
    'taskSelectorService',
    'watchlistService',
  ]

  const registry: Record<string, (input: unknown) => Promise<unknown>> = {}
  for (const name of toolNames) {
    if (typeof g[name] === 'function') {
      registry[name] = g[name] as (input: unknown) => Promise<unknown>
    }
  }

  // Fall back to direct imports if globals aren't injected (e.g., running outside the worker)
  if (Object.keys(registry).length === 0) {
    try {
      const tools = await import('./ed_tools.js')
      for (const [name, fn] of Object.entries(tools)) {
        if (typeof fn === 'function') {
          registry[name] = fn as (input: unknown) => Promise<unknown>
        }
      }
    } catch {
      // ed_tools.ts not available in this context — agent will fail gracefully per-task
    }
  }

  _toolRegistry = registry
  return registry
}

// ---------------------------------------------------------------------------
// plannerAgent
// ---------------------------------------------------------------------------

/**
 * Generates a structured AgentPlan from a user query and optional context.
 *
 * The default implementation builds a simple two-step plan:
 *   1. queryRefinement — clarifies and expands the user query
 *   2. taskSelectorService — selects the most relevant API for the query
 *
 * Replace or extend this function with your own LLM-based planning logic.
 *
 * @param userQuery - The raw user query string
 * @param context   - Optional shared context (user token, session metadata, etc.)
 * @returns A fully-structured AgentPlan ready for execution
 */
export async function plannerAgent(
  userQuery: string,
  context: Record<string, unknown> = {},
): Promise<AgentPlan> {
  const planId = randomUUID()

  const tasks: AgentTask[] = [
    {
      id: 'task-1',
      status: 'pending',
      description: 'Clarify and refine the user query',
      tool: 'queryRefinement',
      input: {
        userInput: userQuery,
        userToken: context['userToken'],
      },
    },
    {
      id: 'task-2',
      status: 'pending',
      description: 'Select the most relevant API for the refined query',
      tool: 'taskSelectorService',
      input: {
        // Placeholder: resolved at execution time from task-1's output
        queryEmbedding: { $ref: 'task-1.output.embedding' },
        topK: 3,
        context,
      },
    },
    {
      id: 'task-3',
      status: 'pending',
      description: 'Execute the selected API with the refined query parameters',
      tool: 'apiService',
      input: {
        baseUrl: { $ref: 'task-2.output.0.baseUrl' },
        schema: { $ref: 'task-2.output.0.schema' },
        userToken: context['userToken'],
      },
    },
  ]

  return {
    id: planId,
    tasks,
    status: 'planning',
    currentTaskIndex: 0,
    context,
    metadata: {
      userQuery,
      createdAt: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// executorAgent
// ---------------------------------------------------------------------------

/**
 * Executes tasks in an AgentPlan sequentially.
 *
 * If `resumeFrom` is provided, tasks before that index are treated as already
 * completed and their outputs are loaded from the plan (no execution occurs).
 *
 * For each task:
 *   - Resolves `$ref` placeholders in the task input using previous outputs
 *   - Invokes the specified tool
 *   - Records output and timestamps on the task
 *   - Tags related trace events with the task's ID and index
 *   - Halts on first failure and marks the plan as failed
 *
 * @param plan       - The AgentPlan to execute
 * @param resumeFrom - Zero-based index to start execution from (default 0)
 * @returns Updated AgentPlan with all executed task results populated
 */
export async function executorAgent(plan: AgentPlan, resumeFrom = 0): Promise<AgentPlan> {
  const tools = await getToolRegistry()

  const updatedTasks: AgentTask[] = [...plan.tasks]
  const updatedPlan: AgentPlan = {
    ...plan,
    tasks: updatedTasks,
    status: 'executing',
    currentTaskIndex: resumeFrom,
  }

  for (let i = 0; i < updatedTasks.length; i++) {
    const task = { ...updatedTasks[i] }
    updatedTasks[i] = task

    // Skip tasks before the resume point — their outputs are already in the plan
    if (i < resumeFrom) {
      // Ensure status reflects completed state even for pre-loaded tasks
      if (task.status !== 'completed') {
        task.status = 'completed'
      }
      continue
    }

    // Build previous outputs map for placeholder resolution
    const previousOutputs = extractTaskOutputs({ ...updatedPlan, tasks: updatedTasks })

    // Resolve any $ref placeholders in the task input
    const resolvedInput = resolveTaskInput(task.input, previousOutputs)

    // Mark task as in-progress
    task.status = 'in-progress'
    task.startedAt = Date.now()
    updatedPlan.currentTaskIndex = i

    const eventIdBeforeTask = currentMaxEventId()

    try {
      const toolFn = tools[task.tool]
      if (!toolFn) {
        throw new Error(`Tool "${task.tool}" not found in registry. Available: ${Object.keys(tools).join(', ')}`)
      }

      const output = await toolFn(resolvedInput)

      task.status = 'completed'
      task.output = output
      task.completedAt = Date.now()

      // Tag all events recorded during this task's execution
      tagRecentEvents(task.id, i, eventIdBeforeTask + 1)
    } catch (err) {
      task.status = 'failed'
      task.error = err instanceof Error ? err.message : String(err)
      task.completedAt = Date.now()

      // Tag events recorded up to the failure point
      tagRecentEvents(task.id, i, eventIdBeforeTask + 1)

      updatedPlan.status = 'failed'
      return updatedPlan
    }
  }

  updatedPlan.status = 'completed'
  updatedPlan.currentTaskIndex = updatedTasks.length
  return updatedPlan
}

// ---------------------------------------------------------------------------
// resumeAgentFromTrace
// ---------------------------------------------------------------------------

/**
 * Entry point for mid-trace agent resumption.
 *
 * Takes a previously serialized AgentState and resumes execution from
 * `state.resumeFromTaskIndex`. All tasks before that index are treated as
 * already completed and their cached outputs are used without re-execution.
 *
 * @param state - Serialized AgentState (from serializeAgentState())
 * @returns Updated AgentPlan with resumed task results
 * @throws If state is invalid or cannot be safely resumed
 */
export async function resumeAgentFromTrace(state: AgentState): Promise<AgentPlan> {
  // Validate and hydrate the state
  const validatedState = deserializeAgentState(state)
  const { plan, resumeFromTaskIndex } = validatedState

  return executorAgent(plan, resumeFromTaskIndex)
}
