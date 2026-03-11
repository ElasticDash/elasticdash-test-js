# Agent Mid-Trace Replay

ElasticDash supports resuming long-running agents from any task in their plan — without re-executing already-completed steps.

## Use Cases

- **Resuming after failures**: If task 3 of 5 fails, fix the issue and re-run from task 3 only
- **Pausing for approval**: Capture state after task 2, get human sign-off, then continue
- **Debugging in isolation**: Re-run a single task with modified input to diagnose a problem

## How It Works

Agents are structured as an **AgentPlan** — an ordered list of **AgentTask** objects. When serialized with captured trace events, this forms an **AgentState** that can be saved and replayed later.

## Quick Start

```ts
import { plannerAgent, executorAgent, resumeAgentFromTrace } from './ed_agents'
import { serializeAgentState, deserializeAgentState } from 'elasticdash-test'
import fs from 'node:fs'

// 1. Generate a plan
const plan = await plannerAgent('Show me sales for Q1', { userToken: 'tok-abc' })

// 2. Execute the plan (runs all tasks sequentially)
const completedPlan = await executorAgent(plan)

// 3. Serialize and save state (e.g., after partial execution)
const state = serializeAgentState(completedPlan, [] /* pass recorder.events in worker context */)
fs.writeFileSync('agent-state.json', JSON.stringify(state, null, 2))

// 4. Later: load saved state and resume from task 2 (0-based index 1)
const savedState = JSON.parse(fs.readFileSync('agent-state.json', 'utf8'))
const stateToResume = deserializeAgentState({ ...savedState, resumeFromTaskIndex: 1 })
const resumedPlan = await resumeAgentFromTrace(stateToResume)

console.log('Resumed plan status:', resumedPlan.status)
console.log('Task outputs:', resumedPlan.tasks.map((t) => ({ id: t.id, status: t.status })))
```

## Data Structures

### AgentState

```ts
interface AgentState {
  plan: AgentPlan               // Full plan with all tasks (completed and pending)
  trace: WorkflowEvent[]        // Captured trace events from previous execution
  resumeFromTaskIndex: number   // Zero-based index — tasks before this are loaded from cache
}
```

### AgentPlan

```ts
interface AgentPlan {
  id: string
  tasks: AgentTask[]
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'paused'
  currentTaskIndex: number
  context: Record<string, unknown>
  metadata: Record<string, unknown>
}
```

### AgentTask

```ts
interface AgentTask {
  id: string
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  description: string
  tool: string          // Name of the tool function to invoke
  input: unknown        // May contain { $ref: "task-N.output.fieldName" } placeholders
  output?: unknown      // Populated after execution
  error?: string
  startedAt?: number
  completedAt?: number
}
```

## Task Input Placeholders

Task inputs can reference previous task outputs using `{ $ref: "taskId.output.fieldPath" }`:

```ts
// task-2 uses the embedding produced by task-1
{
  id: 'task-2',
  tool: 'taskSelectorService',
  input: {
    queryEmbedding: { $ref: 'task-1.output.embedding' },
    topK: 3,
  }
}
```

Placeholders are resolved at execution time by `resolveTaskInput()`.

## Dashboard Integration

When running an agent workflow through the dashboard:

1. **Agent task observations** are visually highlighted with a purple background and left border
2. Each observation shows a **T1 / T2 / T3** badge indicating which task it belongs to
3. In the observation detail panel, a **"Resume from Task N"** button appears (agent steps only)
4. Clicking it calls `/api/resume-agent-from-task` with the serialized `AgentState` and chosen `taskIndex`
5. The resumed run is added as a new trace in the comparison table

## Best Practices

- **Keep tasks idempotent** where possible — if a task must be re-run, ensure it produces the same result
- **Store minimal outputs** — only record what downstream tasks need, not full API responses
- **Version your state schema** — if tool interfaces change, old states may need migration
- **Use sequential tasks** — the current implementation runs tasks one-by-one; parallel task support is planned

## Example: Debugging a Failed Task

```ts
// 1. Original execution fails at task 3
const plan = await plannerAgent('Process refund for order-123')
const result = await executorAgent(plan)
// Error: task 3 (calculateRefundAmount) failed

// 2. Save the state
const state = serializeAgentState(result, recorder.events)
fs.writeFileSync('failed-run.json', JSON.stringify(state))

// 3. Fix the issue in your tool/code

// 4. Resume from task 3 with corrected state
const savedState = JSON.parse(fs.readFileSync('failed-run.json'))
const fixed = await resumeAgentFromTrace({
  ...deserializeAgentState(savedState),
  resumeFromTaskIndex: 2  // 0-based: task 3 = index 2
})

// Tasks 1-2 use cached results; task 3+ execute with fixes
console.log('Fixed plan:', fixed.status)
```
