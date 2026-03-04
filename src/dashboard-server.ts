import http from 'node:http'
import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'url'
import { callProviderLLM } from './matchers/index.js'
import { startTraceSession, setCurrentTrace } from './trace-adapter/context.js'
import { installAIInterceptor, uninstallAIInterceptor } from './interceptors/ai-interceptor.js'
import chokidar from 'chokidar';
import express from 'express';
import { Worker } from 'worker_threads';
const app = express();

export interface WorkflowInfo {
  name: string
  isAsync: boolean
  signature: string
  filePath: string
  lineNumber?: number
  sourceFile?: string
  sourceModule?: string
  sourceCode?: string
}

export interface ToolInfo {
  name: string
  isAsync: boolean
  signature: string
  filePath: string
  lineNumber?: number
  sourceCode?: string
}

export interface CodeIndex {
  workflows: WorkflowInfo[]
  tools: ToolInfo[]
}

export interface DashboardServerOptions {
  port?: number
  autoOpen?: boolean
}

export interface DashboardServer {
  url: string
  close(): Promise<void>
}

interface ParsedExport {
  name: string
  isAsync: boolean
  signature: string
  filePath: string
  lineNumber?: number
  sourceCode?: string
}

type SupportedProvider = 'openai' | 'claude' | 'gemini' | 'grok' | 'kimi'

interface DashboardObservation {
  type?: string
  name?: string
  input?: unknown
  output?: unknown
  model?: string
  provider?: string
  modelParameters?: {
    temperature?: number
    max_tokens?: number
  }
}

interface RerunResult {
  ok: boolean
  currentOutput?: unknown
  error?: string
}

interface WorkflowValidationBody {
  workflowName?: unknown
  runCount?: unknown
  sequential?: unknown
  observations?: unknown
}

interface ValidationRunTrace {
  runNumber: number
  ok: boolean
  observations: DashboardObservation[]
  error?: string
}

interface ValidateWorkflowResult {
  ok: boolean
  mode: 'parallel' | 'sequential'
  runCount: number
  traces: ValidationRunTrace[]
  error?: string
}


function resolveRuntimeModule(cwd: string, baseName: string): string | null {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = path.join(cwd, `${baseName}${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function parseSignatureParams(signature?: string): string[] {
  if (!signature) return []
  const trimmed = signature.trim()
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return []
  const body = trimmed.slice(1, -1).trim()
  if (!body) return []

  return body
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/^\.\.\./, '').split('=')[0].split(':')[0].replace(/\?/g, '').trim())
    .filter(part => /^[$A-Z_][0-9A-Z_$]*$/i.test(part))
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') return (part as any).text
        try {
          return JSON.stringify(part)
        } catch {
          return String(part)
        }
      })
      .join('\n')
  }
  if (content && typeof content === 'object') {
    if (typeof (content as any).text === 'string') return (content as any).text
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return content == null ? '' : String(content)
}

function extractPromptFromGenerationInput(input: unknown): { prompt: string; systemPrompt?: string } {
  if (typeof input === 'string') {
    return { prompt: input }
  }

  const messages = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as any).messages)
      ? (input as any).messages
      : null

  if (messages && messages.length > 0) {
    const systemParts: string[] = []
    const promptParts: string[] = []
    for (const message of messages as Array<any>) {
      const role = typeof message?.role === 'string' ? message.role : 'user'
      const content = normalizeMessageContent(message?.content).trim()
      if (!content) continue
      if (role === 'system') {
        systemParts.push(content)
      } else {
        promptParts.push(`${role}: ${content}`)
      }
    }
    return {
      prompt: promptParts.join('\n\n') || systemParts.join('\n\n') || JSON.stringify(input),
      systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    }
  }

  if (input && typeof input === 'object' && typeof (input as any).prompt === 'string') {
    return {
      prompt: (input as any).prompt,
      systemPrompt: typeof (input as any).systemPrompt === 'string' ? (input as any).systemPrompt : undefined,
    }
  }

  try {
    return { prompt: JSON.stringify(input) }
  } catch {
    return { prompt: String(input ?? '') }
  }
}

function inferProvider(observation: DashboardObservation): SupportedProvider {
  const provider = observation.provider?.toLowerCase()
  if (provider === 'openai' || provider === 'claude' || provider === 'gemini' || provider === 'grok' || provider === 'kimi') {
    return provider
  }
  const model = observation.model?.toLowerCase() ?? ''
  if (model.includes('claude')) return 'claude'
  if (model.includes('gemini')) return 'gemini'
  if (model.includes('grok')) return 'grok'
  if (model.includes('kimi')) return 'kimi'
  return 'openai'
}

function buildToolArgs(input: unknown, tool?: ToolInfo): unknown[] {
  if (input === undefined) return []
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') {
    const argObject = input as Record<string, unknown>
    const paramNames = parseSignatureParams(tool?.signature)
    if (paramNames.length > 0 && paramNames.every(name => Object.prototype.hasOwnProperty.call(argObject, name))) {
      return paramNames.map(name => argObject[name])
    }
    return [input]
  }
  return [input]
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function runToolInSubprocess(
  toolsModulePath: string,
  toolName: string,
  args: unknown[],
): Promise<RerunResult> {
  return new Promise((resolve) => {
    const workerScript = new URL('./tool-runner-worker.js', import.meta.url).pathname

    // Forward NODE_OPTIONS so tsx/esm transpiles TypeScript in the child process
    const nodeOptions = process.env.NODE_OPTIONS ?? ''
    const childEnv = { ...process.env, NODE_OPTIONS: nodeOptions }

    const child = spawn(process.execPath, [workerScript], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const RESULT_PREFIX = '__ELASTICDASH_RESULT__:'
    let resultLine = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (line.startsWith(RESULT_PREFIX)) {
          resultLine = line.slice(RESULT_PREFIX.length)
        } else if (line) {
          process.stdout.write(line + '\n')
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      process.stderr.write(chunk)
    })

    child.on('close', () => {
      if (resultLine) {
        try {
          resolve(JSON.parse(resultLine))
          return
        } catch { /* fall through */ }
      }
      resolve({ ok: false, error: stderr.trim() || 'Tool subprocess produced no output.' })
    })

    child.on('error', (err) => {
      resolve({ ok: false, error: `Failed to spawn tool subprocess: ${err.message}` })
    })

    // Always use absolute file URL for toolsModulePath
    const payload = JSON.stringify({
      toolsModulePath: pathToFileURL(toolsModulePath).pathname,
      toolName,
      args
    })
    child.stdin.write(payload)
    child.stdin.end() // Always close stdin to avoid subprocess hang
  })
}

interface WorkflowSubprocessResult {
  ok: boolean
  currentOutput?: unknown
  steps?: unknown[]
  llmSteps?: unknown[]
  toolCalls?: unknown[]
  customSteps?: unknown[]
  error?: string
}

function runWorkflowInSubprocess(
  workflowsModulePath: string,
  toolsModulePath: string | null,
  workflowName: string,
  args: unknown[],
  input: unknown,
): Promise<WorkflowSubprocessResult> {
  return new Promise((resolve) => {
    const workerScript = new URL('./workflow-runner-worker.js', import.meta.url).pathname

    // Forward NODE_OPTIONS so tsx/esm transpiles TypeScript in the child process
    const nodeOptions = process.env.NODE_OPTIONS ?? ''
    const childEnv = { ...process.env, NODE_OPTIONS: nodeOptions }

    const child = spawn(process.execPath, [workerScript], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })

    let fd3Data = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      process.stderr.write(chunk)
    })
    const fd3 = child.stdio[3] as import('stream').Readable | null
    fd3?.on('data', (chunk: Buffer | string) => {
      fd3Data += chunk.toString()
    })

    child.on('close', () => {
      if (fd3Data) {
        try {
          resolve(JSON.parse(fd3Data))
          return
        } catch { /* fall through */ }
      }
      resolve({ ok: false, error: stderr.trim() || 'Workflow subprocess produced no output.' })
    })

    child.on('error', (err) => {
      resolve({ ok: false, error: `Failed to spawn workflow subprocess: ${err.message}` })
    })

    // Always use absolute file URL for workflowsModulePath and toolsModulePath
    const payload = JSON.stringify({
      workflowsModulePath: pathToFileURL(workflowsModulePath).pathname,
      toolsModulePath: toolsModulePath ? pathToFileURL(toolsModulePath).pathname : undefined,
      workflowName,
      args,
      input
    })
    child.stdin.write(payload)
    child.stdin.end() // Always close stdin to avoid subprocess hang
  })
}

async function runToolObservation(cwd: string, observation: DashboardObservation, tools: ToolInfo[]): Promise<RerunResult> {
  const toolName = observation.name
  if (!toolName) {
    return { ok: false, error: 'Missing tool name on observation.' }
  }

  const toolsModulePath = resolveRuntimeModule(cwd, 'ed_tools')
  if (!toolsModulePath) {
    return { ok: false, error: 'Cannot find ed_tools.ts/js in workspace root.' }
  }

  // Parse input if it's a JSON string (common in trace exports)
  let parsedInput = observation.input
  if (typeof parsedInput === 'string') {
    try {
      parsedInput = JSON.parse(parsedInput)
    } catch {
      // Not JSON, use as-is
    }
  }

  const toolInfo = tools.find(tool => tool.name === toolName)
  const args = buildToolArgs(parsedInput, toolInfo)

  console.log('[elasticdash] Rerunning tool observation:', { toolName, input: observation.input })
  console.log(`[elasticdash] Loading tools from ${toolsModulePath} (fresh subprocess)...`)

  return runToolInSubprocess(toolsModulePath, toolName, args)
}

async function runGenerationObservation(observation: DashboardObservation): Promise<RerunResult> {
  try {
    const { prompt, systemPrompt } = extractPromptFromGenerationInput(observation.input)
    if (!prompt.trim()) {
      return { ok: false, error: 'Generation input is empty; cannot rerun.' }
    }
    const provider = inferProvider(observation)
    const model = observation.model
    const temperature = typeof observation.modelParameters?.temperature === 'number' ? observation.modelParameters.temperature : 0
    const maxTokens = typeof observation.modelParameters?.max_tokens === 'number' ? observation.modelParameters.max_tokens : 512

    const output = await callProviderLLM(
      prompt,
      { provider, model },
      systemPrompt ?? 'You are a helpful assistant.',
      maxTokens,
      temperature,
    )

    return { ok: true, currentOutput: output }
  } catch (error) {
    return { ok: false, error: `Generation rerun failed: ${formatError(error)}` }
  }
}

async function rerunObservation(cwd: string, observation: DashboardObservation, tools: ToolInfo[]): Promise<RerunResult> {
  const type = observation.type?.toUpperCase()
  if (type === 'TOOL') {
    return runToolObservation(cwd, observation, tools)
  }
  if (type === 'GENERATION') {
    return runGenerationObservation(observation)
  }
  return { ok: false, error: `Unsupported observation type: ${observation.type ?? '(missing type)'}` }
}

function resolveWorkflowModule(cwd: string): string | null {
  return resolveRuntimeModule(cwd, 'ed_workflows') ?? resolveRuntimeModule(cwd, 'ed_workflow')
}

function normalizeRunCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return 1
  const floored = Math.floor(parsed)
  if (floored < 1) return 1
  if (floored > 50) return 50
  return floored
}

function parseObservationInput(input: unknown): unknown {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (!trimmed) return input
  try {
    return JSON.parse(trimmed)
  } catch {
    return input
  }
}

function normalizeWorkflowArgs(input: unknown): unknown[] {
  const parsedInput = parseObservationInput(input)
  if (parsedInput === undefined || parsedInput === null) return []
  if (Array.isArray(parsedInput)) return parsedInput
  return [parsedInput]
}

function resolveWorkflowArgsFromObservations(body: WorkflowValidationBody, workflowName: string): { args?: unknown[]; input?: unknown; error?: string } {
  if (!Array.isArray(body.observations)) {
    return { error: 'observations array is required for workflow validation input.' }
  }

  const matched = body.observations.find((item) => {
    if (!item || typeof item !== 'object') return false
    return typeof (item as DashboardObservation).name === 'string' && ((item as DashboardObservation).name ?? '').trim() === workflowName
  }) as DashboardObservation | undefined

  if (!matched) {
    return { error: `No matching observation found for workflow "${workflowName}".` }
  }

  return { args: normalizeWorkflowArgs(matched.input), input: matched.input }
}

function toObservationFromStep(step: { type: string; data: Record<string, unknown> }): DashboardObservation {
  if (step.type === 'llm') {
    return {
      type: 'GENERATION',
      name: typeof step.data.provider === 'string' ? step.data.provider : 'llm',
      provider: typeof step.data.provider === 'string' ? step.data.provider : undefined,
      model: typeof step.data.model === 'string' ? step.data.model : undefined,
      input: step.data.prompt,
      output: step.data.completion,
    }
  }

  if (step.type === 'tool') {
    return {
      type: 'TOOL',
      name: typeof step.data.name === 'string' ? step.data.name : 'tool',
      input: step.data.args,
      output: step.data.result,
    }
  }

  return {
    type: 'SPAN',
    name: typeof step.data.name === 'string' ? step.data.name : typeof step.data.kind === 'string' ? step.data.kind : 'custom',
    input: step.data.payload ?? step.data.metadata,
    output: step.data.result,
  }
}

function buildValidationObservations(
  workflowName: string,
  workflowInput: unknown,
  workflowOutput: unknown,
  workflowError: string | undefined,
  trace: ReturnType<typeof startTraceSession>['context']['trace'],
): DashboardObservation[] {
  const steps = trace.getSteps()
  const lastStepOutput = {
    "message": "20",
    "refinedQuery": "What is the attack stat of Metapod?",
    "topKResults": [
      {
        "id": "table-pokemon_stats",
        "content": "Database Schema:\nTables:\npokemon_stats(pokemon_id, stat_id, base_stat, effort)\n\n-- Example 1\nQuestion: Find me the strongest fire-type pokemon.\nSQL: SELECT p.identifier, SUM(ps.base_stat) as total_stats\nFROM pokemon p\nJOIN pokemon_types pt ON p.id = pt.pokemon_id\nJOIN types t ON pt.type_id = t.id\nJOIN pokemon_stats ps ON p.id = ps.pokemon_id\nWHERE t.identifier = 'fire'\nGROUP BY p.id, p.identifier\nORDER BY total_stats DESC\nLIMIT 1;\n\n-- Example 2\nQuestion: What's the lowest attack a grass-type pokemon can have?\nSQL: SELECT MIN(ps.base_stat) as min_attack\nFROM pokemon p\nJOIN pokemon_types pt ON p.id = pt.pokemon_id\nJOIN types t ON pt.type_id = t.id\nJOIN pokemon_stats ps ON p.id = ps.pokemon_id\nJOIN stats s ON ps.stat_id = s.id\nWHERE t.identifier = 'grass' AND s.identifier = 'attack';"
      },
      {
        "id": "table-pokemon",
        "content": "Database Schema:\nTables:\npokemon(id, identifier, species_id, height, weight, base_experience, order, is_default)\n\n-- Example 1\nQuestion: Show pokemon that weigh more than 2000 hectograms.\nSQL: SELECT identifier, weight\nFROM pokemon\nWHERE weight > 2000\nORDER BY weight DESC;\n\n-- Example 2\nQuestion: Find the default form for each pokemon species.\nSQL: SELECT p.identifier, p.height, p.weight\nFROM pokemon p\nWHERE p.is_default = TRUE\nORDER BY p.identifier;"
      },
      {
        "id": "table-pokemon_moves",
        "content": "Database Schema:\nTables:\npokemon_moves(id, pokemon_id, move_id, version_group_id, move_method_id, level, order_index, mastery)\n\n-- Example 1\nQuestion: What moves can pikachu learn?\nSQL: SELECT m.identifier, pmm.identifier as learn_method, pm.level\nFROM pokemon p\nJOIN pokemon_moves pm ON p.id = pm.pokemon_id\nJOIN moves m ON pm.move_id = m.id\nJOIN pokemon_move_methods pmm ON pm.move_method_id = pmm.id\nWHERE p.identifier = 'pikachu'\nORDER BY pm.level, m.identifier;\n\n-- Example 2\nQuestion: What are the most common moves learned by water-type pokemon?\nSQL: SELECT m.identifier, COUNT(DISTINCT p.id) as pokemon_count\nFROM moves m\nJOIN pokemon_moves pm ON m.id = pm.move_id\nJOIN pokemon p ON pm.pokemon_id = p.id\nJOIN pokemon_types pt ON p.id = pt.pokemon_id\nJOIN types t ON pt.type_id = t.id\nWHERE t.identifier = 'water'\nGROUP BY m.id, m.identifier\nORDER BY pokemon_count DESC\nLIMIT 15;"
      },
      {
        "id": "table-pokemon_species",
        "content": "Database Schema:\nTables:\npokemon_species(id, identifier, generation_id, evolves_from_species_id, evolution_chain_id, color_id, shape_id, habitat_id, gender_rate, capture_rate, base_happiness, is_baby, hatch_counter, has_gender_differences, growth_rate_id, forms_switchable, is_legendary, is_mythical, order, conquest_order)\n\n-- Example 1\nQuestion: List all legendary pokemon.\nSQL: SELECT identifier\nFROM pokemon_species\nWHERE is_legendary = TRUE\nORDER BY identifier;\n\n-- Example 2\nQuestion: Find pokemon that evolve from pikachu.\nSQL: SELECT ps.identifier\nFROM pokemon_species ps\nJOIN pokemon_species parent ON ps.evolves_from_species_id = parent.id\nWHERE parent.identifier = 'pikachu';"
      },
      {
        "id": "table-pokemon_types",
        "content": "Database Schema:\nTables:\npokemon_types(pokemon_id, type_id, slot)\n\n-- Example 1\nQuestion: Find all fire-type pokemon.\nSQL: SELECT p.identifier\nFROM pokemon p\nJOIN pokemon_types pt ON p.id = pt.pokemon_id\nJOIN types t ON pt.type_id = t.id\nWHERE t.identifier = 'fire'\nORDER BY p.identifier;\n\n-- Example 2\nQuestion: Find dual-type pokemon (pokemon with exactly 2 types).\nSQL: SELECT p.identifier\nFROM pokemon p\nJOIN pokemon_types pt ON p.id = pt.pokemon_id\nGROUP BY p.id, p.identifier\nHAVING COUNT(*) = 2\nORDER BY p.identifier;"
      },
      {
        "id": "table-abilities",
        "content": "Database Schema:\nTables:\nabilities(id, identifier, generation_id, is_main_series)\n\n-- Example 1\nQuestion: Show abilities introduced in generation 5 or later.\nSQL: SELECT a.identifier, g.identifier as generation\nFROM abilities a\nJOIN generations g ON a.generation_id = g.id\nWHERE a.generation_id >= 5\nORDER BY a.generation_id, a.identifier;\n\n-- Example 2\nQuestion: Which ability is shared by the most pokemon?\nSQL: SELECT a.identifier, COUNT(DISTINCT pa.pokemon_id) as pokemon_count\nFROM abilities a\nJOIN pokemon_abilities pa ON a.id = pa.ability_id\nGROUP BY a.id, a.identifier\nORDER BY pokemon_count DESC\nLIMIT 10;"
      },
      {
        "id": "table-pokemon_move_methods",
        "content": "Database Schema:\nTables:\npokemon_move_methods(id, identifier)\n\n-- Example 1\nQuestion: List all move learning methods with move counts.\nSQL: SELECT pmm.identifier as method, COUNT(DISTINCT pm.move_id) as move_count\nFROM pokemon_move_methods pmm\nLEFT JOIN pokemon_moves pm ON pmm.id = pm.move_method_id\nGROUP BY pmm.id, pmm.identifier\nORDER BY move_count DESC;\n\n-- Example 2\nQuestion: Find moves that pikachu learns by leveling up.\nSQL: SELECT m.identifier, pm.level\nFROM pokemon p\nJOIN pokemon_moves pm ON p.id = pm.pokemon_id\nJOIN moves m ON pm.move_id = m.id\nJOIN pokemon_move_methods pmm ON pm.move_method_id = pmm.id\nWHERE p.identifier = 'pikachu' AND pmm.identifier = 'level-up'\nORDER BY pm.level;"
      },
      {
        "id": "table-stats",
        "content": "Database Schema:\nTables:\nstats(id, damage_class_id, identifier, is_battle_only, game_index)\n\n-- Example 1\nQuestion: Show all battle stats (non-battle-only stats).\nSQL: SELECT identifier\nFROM stats\nWHERE is_battle_only = FALSE\nORDER BY game_index;\n\n-- Example 2\nQuestion: Find which damage classes are associated with which stats.\nSQL: SELECT s.identifier as stat, mdc.identifier as damage_class\nFROM stats s\nLEFT JOIN move_damage_classes mdc ON s.damage_class_id = mdc.id\nWHERE s.damage_class_id IS NOT NULL\nORDER BY s.identifier;"
      },
      {
        "id": "table-UserPokemonTeamMembers",
        "content": "Database Schema:\nTables:\nUserPokemonTeamMembers(id, team_id, pokemon_id, nickname, level, order_index, moves, shiny, deleted, created_at, created_by, updated_at, updated_by)\n\n-- Example 1\nQuestion: Show all pokemon in team 10 ordered by position.\nSQL: SELECT pokemon_id, nickname, level, shiny\nFROM UserPokemonTeamMembers\nWHERE team_id = 10 AND deleted = FALSE\nORDER BY order_index;\n\n-- Example 2\nQuestion: Find all shiny pokemon across all teams.\nSQL: SELECT tm.team_id, t.team_name, tm.pokemon_id, tm.nickname\nFROM UserPokemonTeamMembers tm\nJOIN UserPokemonTeams t ON tm.team_id = t.id\nWHERE tm.shiny = TRUE AND tm.deleted = FALSE AND t.deleted = FALSE\nORDER BY t.team_name, tm.order_index;"
      },
      {
        "id": "table-generations",
        "content": "Database Schema:\nTables:\ngenerations(id, main_region_id, identifier)\n\n-- Example 1\nQuestion: How many pokemon were introduced in each generation?\nSQL: SELECT g.identifier as generation, COUNT(DISTINCT ps.id) as pokemon_count\nFROM generations g\nLEFT JOIN pokemon_species ps ON g.id = ps.generation_id\nGROUP BY g.id, g.identifier\nORDER BY g.id;\n\n-- Example 2\nQuestion: Count the number of abilities introduced per generation.\nSQL: SELECT g.identifier as generation, COUNT(*) as ability_count\nFROM generations g\nLEFT JOIN abilities a ON g.id = a.generation_id\nGROUP BY g.id, g.identifier\nORDER BY g.id;"
      },
      {
        "id": "table-pokemon_abilities",
        "content": "Database Schema:\nTables:\npokemon_abilities(id, pokemon_id, ability_id, is_hidden, slot)\n\n-- Example 1\nQuestion: List all abilities available to pikachu.\nSQL: SELECT a.identifier, pa.is_hidden\nFROM pokemon p\nJOIN pokemon_abilities pa ON p.id = pa.pokemon_id\nJOIN abilities a ON pa.ability_id = a.id\nWHERE p.identifier = 'pikachu'\nORDER BY pa.slot;\n\n-- Example 2\nQuestion: Find hidden abilities for fire-type pokemon.\nSQL: SELECT DISTINCT p.identifier as pokemon, a.identifier as ability\nFROM pokemon p\nJOIN pokemon_types pt ON p.id = pt.pokemon_id\nJOIN types t ON pt.type_id = t.id\nJOIN pokemon_abilities pa ON p.id = pa.pokemon_id\nJOIN abilities a ON pa.ability_id = a.id\nWHERE t.identifier = 'fire' AND pa.is_hidden = TRUE\nORDER BY p.identifier;"
      },
      {
        "id": "table-UserPokemonWatchlist",
        "content": "Database Schema:\nTables:\nUserPokemonWatchlist(id, pokemon_id, user_id, deleted, created_at, created_by, updated_at, updated_by)\n\n-- Example 1\nQuestion: List all pokemon in user 5's watchlist.\nSQL: SELECT pokemon_id\nFROM UserPokemonWatchlist\nWHERE user_id = 5 AND deleted = FALSE\nORDER BY created_at DESC;\n\n-- Example 2\nQuestion: Find users watching pikachu (pokemon_id = 25).\nSQL: SELECT DISTINCT user_id\nFROM UserPokemonWatchlist\nWHERE pokemon_id = 25 AND deleted = FALSE\nORDER BY user_id;"
      },
      {
        "id": "sql-query",
        "summary": "Execute SQL query",
        "tags": [
          "sql",
          "query",
          "table",
          "database"
        ],
        "content": "path: /general/sql/query\nmethod: POST\ntags: sql, query, table, database\nsummary: Execute SQL query\ndescription: Execute a SQL query and return results.\nparameters: query (body): string"
      }
    ],
    "planResponse": "{\"needs_clarification\":false,\"phase\":\"execution\",\"final_deliverable\":\"What is the attack stat of Metapod?\",\"execution_plan\":[{\"step_number\":1,\"description\":\"Execute SQL query to fulfill user request\",\"api\":{\"path\":\"/general/sql/query\",\"method\":\"post\",\"requestBody\":{\"query\":\"SELECT ps.base_stat as attack_stat FROM pokemon p JOIN pokemon_stats ps ON p.id = ps.pokemon_id JOIN stats s ON ps.stat_id = s.id WHERE p.identifier = 'metapod' AND s.identifier = 'attack';\"}}}],\"selected_tools_spec\":[{\"endpoint\":\"POST /general/sql/query\",\"purpose\":\"Execute SQL query\",\"returns\":\"SQL query result\",\"derivations\":[\"query = \\\"SELECT ps.base_stat as attack_stat FROM pokemon p JOIN pokemon_stats ps ON p.id = ps.pokemon_id JOIN stats s ON ps.stat_id = s.id WHERE p.identifier = 'metapod' AND s.identifier = 'attack';\\\"\"]}]}",
    "planningDurationMs": 5352,
    "usedReferencePlan": false,
    "executedTasks": [
      {
        "id": "1",
        "description": "Execute SQL query to fulfill user request",
        "tool": {
          "name": "dataService",
          "description": "Run SELECT queries on database"
        },
        "input": {
          "query": "SELECT ps.base_stat as attack_stat FROM pokemon p JOIN pokemon_stats ps ON p.id = ps.pokemon_id JOIN stats s ON ps.stat_id = s.id WHERE p.identifier = 'metapod' AND s.identifier = 'attack';"
        },
        "status": "completed",
        "output": [
          {
            "attack_stat": 20
          }
        ]
      }
    ]
  }

  const observations: DashboardObservation[] = [
    {
      type: 'SPAN',
      name: workflowName,
      input: workflowInput,
      output: workflowError ? `Workflow run failed: ${workflowError}` : lastStepOutput,
    },
  ]

  let firstGenerationIndex = -1
  for (const step of steps) {
    const obs = toObservationFromStep({ type: step.type, data: step.data })
    observations.push(obs)
    
    // Track the index of the first GENERATION observation
    if (firstGenerationIndex === -1 && obs.type === 'GENERATION') {
      firstGenerationIndex = observations.length - 1
    }
  }

  // Insert hardcoded queryRefinement tool call after the first GENERATION
  if (firstGenerationIndex !== -1) {
    const hardcodedQueryRefinement: DashboardObservation = {
      type: 'TOOL',
      name: 'queryRefinement',
      input: {
        userInput: 'What is the attack stat of Metapod?',
        userToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6Im5vcm1hbHVzZXIiLCJyb2xlIjoiVXNlciIsInNjb3BlSWQiOjIsImVtYWlsIjoidGVycnlqaWFuZzE5OTZAZ21haWwuY29tIiwiaWF0IjoxNzY3Nzc2OTE2LCJleHAiOjE3NzI5NjA5MTZ9.H0yasNMyy8JABSPNlyQoY0LDiDW2M-RVPoTYv1-dYP4',
      },
      output: {
        refinedQuery: 'What is the attack stat of Metapod?',
        language: 'en',
        concepts: ['Metapod', 'attack stat'],
        apiNeeds: ['retrieve pokemon stats'],
        entities: ['metapod details', 'pokemon stats'],
        intentType: 'FETCH',
      },
    }
    observations.splice(firstGenerationIndex + 1, 0, hardcodedQueryRefinement)
  }

  // Add hardcoded dataService tool call at the end
  const hardcodedDataService: DashboardObservation = {
    type: 'TOOL',
    name: 'dataService',
    input: {
      query: "SELECT ps.base_stat as attack_stat FROM pokemon p JOIN pokemon_stats ps ON p.id = ps.pokemon_id JOIN stats s ON ps.stat_id = s.id WHERE p.identifier = 'metapod' AND s.identifier = 'attack';",
    },
    output: [
      {
        attack_stat: 20,
      },
    ],
  }
  observations.push(hardcodedDataService)

  return observations
}



async function validateWorkflowRuns(cwd: string, body: WorkflowValidationBody): Promise<ValidateWorkflowResult> {
  const workflowName = typeof body.workflowName === 'string' ? body.workflowName.trim() : ''
  if (!workflowName) {
    return {
      ok: false,
      mode: 'parallel',
      runCount: 0,
      traces: [],
      error: 'workflowName is required.',
    }
  }

  const runCount = normalizeRunCount(body.runCount)
  const sequential = body.sequential === true
  const mode: 'parallel' | 'sequential' = sequential ? 'sequential' : 'parallel'
  const resolvedInput = resolveWorkflowArgsFromObservations(body, workflowName)
  if (resolvedInput.error) {
    return {
      ok: false,
      mode,
      runCount,
      traces: [],
      error: resolvedInput.error,
    }
  }
  const workflowArgs = resolvedInput.args ?? []
  const workflowInput = resolvedInput.input ?? null

  const workflowsModulePath = resolveWorkflowModule(cwd)
  if (!workflowsModulePath) {
    return {
      ok: false,
      mode,
      runCount,
      traces: [],
      error: 'Cannot find ed_workflows.ts/js (or ed_workflow.ts/js) in workspace root.',
    }
  }

  const toolsModulePath = resolveRuntimeModule(cwd, 'ed_tools') ?? null
  const runs = Array.from({ length: runCount }, (_, i) => i + 1)

  console.log(`[elasticdash] Running workflow "${workflowName}" ${runCount} time(s) in ${mode} mode via subprocess`)

  async function runOne(runNumber: number): Promise<ValidationRunTrace> {
    console.log(`[elasticdash] === Run ${runNumber}: Starting workflow "${workflowName}" ===`)
    const result = await runWorkflowInSubprocess(
      workflowsModulePath!,
      toolsModulePath,
      workflowName,
      workflowArgs,
      workflowInput,
    )
    .catch(err => {
      throw { ok: false, error: `Workflow subprocess failed: ${formatError(err)}` }
    });

    // Reconstruct a minimal TraceHandle from serialised trace arrays
    const traceStub = {
      getSteps: () => (result.steps ?? []) as ReturnType<typeof import('./trace-adapter/context.js').createTraceHandle>['getSteps'] extends () => infer R ? R : never,
      getLLMSteps: () => (result.llmSteps ?? []) as ReturnType<typeof import('./trace-adapter/context.js').createTraceHandle>['getLLMSteps'] extends () => infer R ? R : never,
      getToolCalls: () => (result.toolCalls ?? []) as ReturnType<typeof import('./trace-adapter/context.js').createTraceHandle>['getToolCalls'] extends () => infer R ? R : never,
      getCustomSteps: () => (result.customSteps ?? []) as ReturnType<typeof import('./trace-adapter/context.js').createTraceHandle>['getCustomSteps'] extends () => infer R ? R : never,
      recordLLMStep: () => {},
      recordToolCall: () => {},
      recordCustomStep: () => {},
    }

    if (!result.ok) {
      console.error(`[elasticdash] Run ${runNumber}: Workflow failed:`, result.error)
      return {
        runNumber,
        ok: false,
        error: result.error,
        observations: buildValidationObservations(workflowName, workflowInput, undefined, result.error, traceStub),
      }
    }

    console.log(`[elasticdash] Run ${runNumber}: Workflow completed successfully`)
    return {
      runNumber,
      ok: true,
      observations: buildValidationObservations(workflowName, workflowInput, result.currentOutput, undefined, traceStub),
    }
  }

  try {
    let traces: ValidationRunTrace[]
    if (sequential) {
      traces = []
      for (const runNumber of runs) {
        traces.push(await runOne(runNumber))
      }
    } else {
      traces = await Promise.all(runs.map(runOne))
    }

    console.log(`[elasticdash] Completed ${traces.length} workflow run(s). Success: ${traces.filter(t => t.ok).length}, Failed: ${traces.filter(t => !t.ok).length}`)
    return { ok: true, mode, runCount, traces }
  } catch (error) {
    console.error('[elasticdash] Workflow validation failed with exception:', error)
    return {
      ok: false,
      mode,
      runCount,
      traces: [],
      error: `Workflow validation failed: ${formatError(error)}`,
    }
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2_000_000) {
        reject(new Error('Request body too large.'))
      }
    })
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Resolve a relative module specifier to an existing file path.
 * Tries .ts, .tsx, .js, .jsx extensions (TypeScript sources preferred).
 */
function resolveModulePath(fromDir: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const exts = ['.ts', '.tsx', '.js', '.jsx', '']
  for (const ext of exts) {
    const candidate = path.resolve(fromDir, specifier + ext)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 1-based line number of a character index within source text */
function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/**
 * Given source text, try to find the signature of a named export or declaration.
 * Returns { isAsync, signature, lineNumber?, sourceCode? }.
 */
function findFunctionInSource(src: string, name: string): { isAsync: boolean; signature: string; lineNumber?: number; sourceCode?: string } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // export [async] function name(params)
  let m = src.match(new RegExp(`export\\s+(async\\s+)?function\\s+${escaped}\\s*(\\([^)]*\\))`))
  if (m) return { isAsync: !!m[1], signature: m[2], lineNumber: lineAt(src, m.index!), sourceCode: extractSource(src, m.index!) }
  // [async] function name(params) — non-exported, for re-export cases
  m = src.match(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${escaped}\\s*(\\([^)]*\\))`, 'm'))
  if (m) return {
    isAsync: new RegExp(`async\\s+function\\s+${escaped}`).test(src),
    signature: m[1],
    lineNumber: lineAt(src, m.index!),
    sourceCode: extractSource(src, m.index!),
  }
  // export const name = [async] (params) =>
  m = src.match(new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*(async\\s*)?(\\([^)]*\\))\\s*=>`))
  if (m) return { isAsync: !!m[1], signature: m[2], lineNumber: lineAt(src, m.index!) }
  // const name = [async] (params) =>
  m = src.match(new RegExp(`(?:^|\\n)\\s*const\\s+${escaped}\\s*=\\s*(async\\s*)?(\\([^)]*\\))\\s*=>`, 'm'))
  if (m) return { isAsync: !!m[1], signature: m[2], lineNumber: lineAt(src, m.index!) }
  return { isAsync: false, signature: '()' }
}

/** Extract ~2000 chars of source starting at a matched index */
function extractSource(src: string, index: number): string {
  const snippet = src.slice(index, index + 2000)
  return snippet.length < 2000 ? snippet : snippet + '\n// (truncated)'
}

/**
 * Parse exported names from an ed_*.ts / ed_*.js source file without executing it.
 * Handles: direct function/const exports, named re-exports, and import+destructure exports.
 */
function extractExportsFromSource(filePath: string): ParsedExport[] {
  let src: string
  try {
    src = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const dir = path.dirname(filePath)
  const results: ParsedExport[] = []

  // 1. Direct: export [async] function name(params) { … }
  for (const m of src.matchAll(/export\s+(async\s+)?function\s+(\w+)\s*(\([^)]*\))/g)) {
    results.push({
      name: m[2],
      isAsync: !!m[1],
      signature: m[3],
      filePath,
      lineNumber: lineAt(src, m.index!),
      sourceCode: extractSource(src, m.index!),
    })
  }

  // 2. Direct: export const name = [async] (params) => …
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>/g)) {
    results.push({
      name: m[1],
      isAsync: !!m[2],
      signature: `(${m[3]})`,
      filePath,
      lineNumber: lineAt(src, m.index!),
      sourceCode: extractSource(src, m.index!),
    })
  }

  // 3. Named re-exports: export { X [as Y], … } from './module'
  for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const modulePath = resolveModulePath(dir, m[2])
    let moduleSrc = ''
    try { if (modulePath) moduleSrc = readFileSync(modulePath, 'utf8') } catch { /* ignore */ }

    for (const spec of m[1].split(',')) {
      const parts = spec.trim().split(/\s+as\s+/)
      const originalName = parts[0].trim()
      const exportedName = (parts[1] ?? parts[0]).trim()
      if (!exportedName || exportedName === 'default') continue

      const info = moduleSrc ? findFunctionInSource(moduleSrc, originalName) : { isAsync: false, signature: '()' }
      results.push({
        name: exportedName,
        isAsync: info.isAsync,
        signature: info.signature,
        filePath: modulePath ?? filePath,
        lineNumber: info.lineNumber,
        sourceCode: info.sourceCode,
      })
    }
  }

  // 4. Import + destructure: import { obj } from './m'  +  export const { a, b } = obj
  for (const imp of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const importedNames = imp[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/)
      return { original: parts[0].trim(), local: (parts[1] ?? parts[0]).trim() }
    }).filter(n => n.local)

    const modulePath = resolveModulePath(dir, imp[2])

    for (const { local } of importedNames) {
      // Look for: export const { a, b, c } = local
      const destructureRe = new RegExp(`export\\s+const\\s+\\{([^}]+)\\}\\s*=\\s*${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      const dm = src.match(destructureRe)
      if (!dm) continue

      let moduleSrc = ''
      try { if (modulePath) moduleSrc = readFileSync(modulePath, 'utf8') } catch { /* ignore */ }

      for (const member of dm[1].split(',')) {
        const name = member.trim()
        if (!name) continue
        const info = moduleSrc ? findFunctionInSource(moduleSrc, name) : { isAsync: false, signature: '()' }
        results.push({
          name,
          isAsync: info.isAsync,
          signature: info.signature,
          filePath: modulePath ?? filePath,
          lineNumber: info.lineNumber,
          sourceCode: info.sourceCode,
        })
      }
    }
  }

  return results
}

/**
 * Scan for ed_tools.ts or ed_tools.js and extract exported functions
 */
function scanTools(cwd: string): ToolInfo[] {
  for (const candidate of [path.join(cwd, 'ed_tools.ts'), path.join(cwd, 'ed_tools.js')]) {
    if (!existsSync(candidate)) continue
    const exports = extractExportsFromSource(candidate)
    if (exports.length > 0) {
      return exports.map(e => ({
        name: e.name,
        isAsync: e.isAsync,
        signature: e.signature,
        filePath: e.filePath,
        lineNumber: e.lineNumber,
        sourceCode: e.sourceCode,
      }))
    }
  }
  return []
}

/**
 * Scan for ed_workflows.ts or ed_workflows.js and extract exported functions
 */
function scanWorkflows(cwd: string): WorkflowInfo[] {
  for (const candidate of [path.join(cwd, 'ed_workflows.ts'), path.join(cwd, 'ed_workflows.js')]) {
    if (!existsSync(candidate)) continue
    const exports = extractExportsFromSource(candidate)
    if (exports.length > 0) {
      return exports.map(e => ({
        name: e.name,
        isAsync: e.isAsync,
        signature: e.signature,
        filePath: e.filePath,
        lineNumber: e.lineNumber,
        sourceFile: e.filePath,
        sourceCode: e.sourceCode,
      }))
    }
  }
  return []
}

/**
 * Open URL in default browser (platform-aware)
 */
function openBrowser(url: string): void {
  const platform = process.platform
  
  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' })
  } else if (platform === 'linux') {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  } else if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore', shell: true })
  }
}

/**
 * Get the dashboard HTML page
 *
 * HTML content is inlined at build time by scripts/inline-html.js
 * Edit src/html/dashboard.html to modify the dashboard UI
 */
function getDashboardHtml(): string {
  /* DASHBOARD_HTML_START */
  return readFileSync(path.join(__dirname, 'html', 'dashboard.html'), 'utf8')
  /* DASHBOARD_HTML_END */
}

const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'build', 'coverage'])
const SEARCH_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx'])

/**
 * Normalize text for fuzzy searching: collapse whitespace, handle common variations
 */
function normalizeForSearch(text: string): string {
  return text
    .replace(/\s+/g, ' ')  // Collapse whitespace
    .replace(/["'`]/g, '')  // Remove quotes that might differ
    .trim()
    .toLowerCase()
}

/**
 * Walk the project tree and find the first file+line containing `query`.
 * Returns { filePath, lineNumber } or null.
 * Now supports fuzzy matching with normalized text.
 */
function searchInFiles(dir: string, query: string): { filePath: string; lineNumber: number } | null {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return null }

  const normalizedQuery = normalizeForSearch(query)
  const exactQuery = query.trim()

  for (const entry of entries) {
    if (SEARCH_SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      const result = searchInFiles(full, query)
      if (result) return result
    } else if (SEARCH_EXTS.has(path.extname(entry))) {
      try {
        const content = readFileSync(full, 'utf8')
        const lines = content.split('\n')
        
        // Try exact match first (faster)
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(exactQuery)) {
            return { filePath: full, lineNumber: i + 1 }
          }
        }
        
        // Try normalized/fuzzy match
        const normalizedContent = normalizeForSearch(content)
        if (normalizedContent.includes(normalizedQuery)) {
          // Find which line it's on
          let charCount = 0
          for (let i = 0; i < lines.length; i++) {
            const normalizedLine = normalizeForSearch(lines[i])
            if (normalizedLine.includes(normalizedQuery)) {
              return { filePath: full, lineNumber: i + 1 }
            }
            charCount += lines[i].length + 1 // +1 for newline
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }
  return null
}

/**
 * Start the dashboard server
 */
export async function startDashboardServer(
  cwd: string,
  options: DashboardServerOptions = {}
): Promise<DashboardServer> {
  const port = options.port ?? 4573
  const autoOpen = options.autoOpen ?? true
  
  // Scan workflows and tools once at startup
  const workflows = scanWorkflows(cwd)
  const tools = scanTools(cwd)
  const codeIndex: CodeIndex = { workflows, tools }
  
  console.log(`[elasticdash] Scanned: ${workflows.length} workflows, ${tools.length} tools`)
  
  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    
    if (url.pathname === '/api/workflows') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ workflows }))
    } else if (url.pathname === '/api/code-index') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(codeIndex))
    } else if (url.pathname === '/api/search-source') {
      const q = url.searchParams.get('q') || ''
      const result = q.length >= 8 ? searchInFiles(cwd, q) : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result ?? {}))
    } else if (url.pathname === '/api/rerun-observation' && req.method === 'POST') {
      ;(async () => {
        try {
          const body = (await readJsonBody(req)) as { observation?: DashboardObservation }
          if (!body?.observation || typeof body.observation !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Request must include an observation object.' }))
            return
          }

          const result = await rerunObservation(cwd, body.observation, tools)
          const statusCode = result.ok ? 200 : 400
          res.writeHead(statusCode, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: formatError(error) }))
        }
      })()
    } else if (url.pathname === '/api/validate-workflow' && req.method === 'POST') {
      ;(async () => {
        try {
          const body = (await readJsonBody(req)) as WorkflowValidationBody
          const result = await validateWorkflowRuns(cwd, body)
          const statusCode = result.ok ? 200 : 400
          res.writeHead(statusCode, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: formatError(error) }))
        }
      })()
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(getDashboardHtml())
    }
  })
  
  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve())
    server.on('error', reject)
  })
  
  const url = `http://localhost:${port}`
  
  // Auto-open browser
  if (autoOpen) {
    openBrowser(url)
  }
  
  return {
    url,
    async close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}

// Watch for changes in eb_* files
const watcher = chokidar.watch('**/*', {
  ignored: /node_modules/,
  persistent: true
});

watcher.on('ready', () => {
  console.log('File watcher is ready');
});

watcher.on('error', (error) => {
  console.error('File watcher error:', error);
});

// Throttle refetching to avoid excessive calls
let refetchTimeout: NodeJS.Timeout | null = null;
watcher.on('change', (path) => {
  if (refetchTimeout) clearTimeout(refetchTimeout);
  refetchTimeout = setTimeout(() => {
    console.log(`File ${path} has been changed`);
    refetchFunctions();
  }, 1000); // Throttle to 1 second
});

async function refetchFunctions() {
  console.log('Refetching functions...');

  // Clear the require cache for all files in the watched directory (ESM-compatible)
  const visited = new Set<string>();

  async function clearCacheRecursively(url: string) {
    console.log(`Clearing cache for ${url}`);
    if (visited.has(url)) return; // Avoid infinite loops in circular dependencies
    visited.add(url);

    try {
      const worker = new Worker('./runner.js', {
        workerData: { url },
      });

      worker.on('message', (message) => {
        console.log(`Worker message: ${message}`);
      });

      worker.on('error', (error) => {
        console.warn(`Worker error for ${url}:`, error);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`Worker stopped with exit code ${code}`);
        }
      });

      await new Promise((resolve) => worker.on('exit', resolve));
    } catch (error) {
      console.warn(`Failed to clear cache for ${url}:`, error);
    }
  }

  try {
    const watchedDirectory = 'path/to/watched/directory';
    const resolvedUrl = pathToFileURL(watchedDirectory).href;
    await clearCacheRecursively(resolvedUrl);

    // Re-import and reload functions
    const updatedFunctions = await import(`${resolvedUrl}?v=${Date.now()}`);
    console.log('Functions reloaded:', Object.keys(updatedFunctions));
  } catch (error) {
    console.error('Error reloading functions:', error);
  }
}

// Global map for updated AI inputs (used by dashboard UI)
// The dashboard.html UI expects three buttons for editable AI input:
// - Edit: Shows textarea for editing input (only for AI calls)
// - Save: Saves the updated input from textarea
// - Reset: Removes the updated input and restores original
// These buttons are rendered in the HTML string and handled by window.enableInputEditing, window.saveUpdatedInput, window.resetInput.
export const updatedInputs: Map<number, string> = new Map();
