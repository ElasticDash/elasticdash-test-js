/**
 * examples/agent.ai.test.ts
 *
 * Demonstrates the agent mid-trace replay workflow:
 *   1. Plan generation from a user query
 *   2. Full agent execution (planning + execution)
 *   3. Capturing agent state at a midpoint
 *   4. Resuming the agent from a specific task
 *   5. Verifying resumed outputs match expectations
 */

import '../src/test-setup.js'
import { expect } from '../src/matchers/index.js'
import type { AITestContext } from '../src/trace-adapter/context.js'
import { serializeAgentState, deserializeAgentState, extractTaskOutputs } from '../src/core/agent-state.js'
import type { AgentPlan, AgentTask } from '../src/types/agent.js'

// ---------------------------------------------------------------------------
// Test helpers — lightweight stubs so tests don't require real API keys
// ---------------------------------------------------------------------------

function makeTask(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    status: 'pending',
    description: `Task ${id}`,
    tool: 'dataService',
    input: { query: `SELECT * FROM items WHERE id = '${id}'` },
    ...overrides,
  }
}

function makePlan(tasks: AgentTask[]): AgentPlan {
  return {
    id: 'plan-test-001',
    tasks,
    status: 'executing',
    currentTaskIndex: 0,
    context: { sessionId: 'test-session' },
    metadata: { userQuery: 'show me items' },
  }
}

// Simulate an executor that runs tasks sequentially (offline stub)
async function stubExecutor(plan: AgentPlan, resumeFrom = 0): Promise<AgentPlan> {
  const tasks = plan.tasks.map((t) => ({ ...t }))
  for (let i = resumeFrom; i < tasks.length; i++) {
    const task = tasks[i]
    task.status = 'in-progress'
    task.startedAt = Date.now()
    // Stub: produce a deterministic output
    task.output = { result: `output-for-${task.id}`, taskIndex: i }
    task.status = 'completed'
    task.completedAt = Date.now()
  }
  return { ...plan, tasks, status: 'completed', currentTaskIndex: tasks.length }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

aiTest('agent plan can be created and serialized', async (_ctx: AITestContext) => {
  const tasks = [makeTask('task-1'), makeTask('task-2'), makeTask('task-3')]
  const plan = makePlan(tasks)

  // Serialize with an empty trace (no real execution yet)
  const state = serializeAgentState(plan, [])

  expect(state.plan.id).toBe('plan-test-001')
  expect(state.plan.tasks).toHaveLength(3)
  // All tasks are pending, so resumeFromTaskIndex should be 0
  expect(state.resumeFromTaskIndex).toBe(0)
})

aiTest('agent executes plan and records outputs', async (_ctx: AITestContext) => {
  const tasks = [makeTask('task-1'), makeTask('task-2')]
  const plan = makePlan(tasks)

  const result = await stubExecutor(plan)

  expect(result.status).toBe('completed')
  expect(result.tasks[0].status).toBe('completed')
  expect(result.tasks[0].output).toEqual({ result: 'output-for-task-1', taskIndex: 0 })
  expect(result.tasks[1].status).toBe('completed')
  expect(result.tasks[1].output).toEqual({ result: 'output-for-task-2', taskIndex: 1 })
})

aiTest('agent state can be serialized and deserialized after partial execution', async (_ctx: AITestContext) => {
  const tasks = [
    makeTask('task-1', {
      status: 'completed',
      output: { userId: 'u-42' },
      startedAt: Date.now() - 1000,
      completedAt: Date.now() - 500,
    }),
    makeTask('task-2'),
    makeTask('task-3'),
  ]
  const plan = makePlan(tasks)

  const state = serializeAgentState(plan, [])

  // task-1 is completed, so resumeFromTaskIndex should be 1
  expect(state.resumeFromTaskIndex).toBe(1)

  // Deserialize and validate
  const restored = deserializeAgentState(state)
  expect(restored.resumeFromTaskIndex).toBe(1)
  expect(restored.plan.tasks[0].status).toBe('completed')
  expect(restored.plan.tasks[0].output).toEqual({ userId: 'u-42' })
})

aiTest('agent resumes from a specific task without re-executing completed tasks', async (_ctx: AITestContext) => {
  // Set up: task-1 already completed, task-2 and task-3 pending
  const tasks = [
    makeTask('task-1', {
      status: 'completed',
      output: { result: 'original-task-1-output', taskIndex: 0 },
      startedAt: Date.now() - 2000,
      completedAt: Date.now() - 1000,
    }),
    makeTask('task-2'),
    makeTask('task-3'),
  ]
  const plan = makePlan(tasks)
  const state = serializeAgentState(plan, [])

  // Resume from task index 1 (skipping task-1)
  const resumedState = deserializeAgentState({ ...state, resumeFromTaskIndex: 1 })
  const result = await stubExecutor(resumedState.plan, resumedState.resumeFromTaskIndex)

  // task-1 output should be UNCHANGED (the original cached output)
  expect(result.tasks[0].output).toEqual({ result: 'original-task-1-output', taskIndex: 0 })

  // task-2 and task-3 should be freshly executed
  expect(result.tasks[1].status).toBe('completed')
  expect(result.tasks[1].output).toEqual({ result: 'output-for-task-2', taskIndex: 1 })
  expect(result.tasks[2].status).toBe('completed')
  expect(result.tasks[2].output).toEqual({ result: 'output-for-task-3', taskIndex: 2 })
})

aiTest('extractTaskOutputs returns outputs for completed tasks only', async (_ctx: AITestContext) => {
  const tasks = [
    makeTask('task-1', { status: 'completed', output: { value: 'aaa' } }),
    makeTask('task-2', { status: 'in-progress' }),
    makeTask('task-3', { status: 'failed', error: 'timeout' }),
  ]
  const plan = makePlan(tasks)

  const outputs = extractTaskOutputs(plan)

  expect(Object.keys(outputs)).toHaveLength(1)
  expect(outputs['task-1']).toEqual({ value: 'aaa' })
  expect(outputs['task-2']).toBeUndefined()
  expect(outputs['task-3']).toBeUndefined()
})

aiTest('deserialized state validates completed tasks have outputs', async (_ctx: AITestContext) => {
  // task-1 is marked completed but has no output — should throw
  const badState = {
    plan: makePlan([
      makeTask('task-1', { status: 'completed' /* no output */ }),
      makeTask('task-2'),
    ]),
    trace: [],
    resumeFromTaskIndex: 1,
  }

  expect(() => deserializeAgentState(badState)).toThrow(/no output/)
})
