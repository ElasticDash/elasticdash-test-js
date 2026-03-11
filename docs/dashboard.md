# Workflows Dashboard

Browse, search, and run all available workflow and tool functions in your project.

## Starting the Dashboard

```bash
npx elasticdash dashboard         # open dashboard at http://localhost:4573
npx elasticdash dashboard --port 4572  # use custom port
npx elasticdash dashboard --no-open    # skip auto-opening browser
```

### Framework Runtime Compatibility (Next.js, TS Path Aliases)

If your project uses **TypeScript path aliases** (e.g., `@/lib/...`) or requires runtime TypeScript loading, you may need to configure Node.js loaders.

**Standard command (works for most projects):**

```bash
npx elasticdash dashboard
```

**Advanced command (Next.js, mixed ESM/CJS, path aliases):**

```bash
NODE_OPTIONS='--import tsx/esm --require tsx/cjs --require tsconfig-paths/register' npx elasticdash dashboard
```

Or add to `package.json`:

```json
{
  "scripts": {
    "dashboard:ai": "NODE_OPTIONS='--import tsx/esm --require tsx/cjs --require tsconfig-paths/register' elasticdash dashboard"
  }
}
```

**Why this works:**
- `tsx/esm` and `tsx/cjs` handle mixed ESM/CJS module loading at runtime
- `tsconfig-paths/register` resolves path mappings from `tsconfig.json` (e.g., `@/services/*` → `./src/services/*`)

**How to check if you're using ESM or CJS:**

Look at your `package.json`:
- `"type": "module"` → ESM (uses `import`/`export`)
- No `type` field or `"type": "commonjs"` → CJS (uses `require`/`module.exports`)

**When you need the advanced setup:**

- **Any file in your project uses path aliases** (e.g., `@/lib/*`, `@/services/*`) instead of relative imports (`../`) - **this is the main reason**
- Your project mixes ESM (`import`) and CJS (`require`) in the same execution path
- You see errors like `Cannot find module '@/...'` or `ERR_UNKNOWN_FILE_EXTENSION`

**Important:** Path alias resolution is transitive. If your workflows import files that use `@/` aliases, you need the advanced setup even if `ed_workflows.ts` itself uses only relative imports.

**When you DON'T need it:**
- Plain JavaScript projects (`.js` files only)
- **Basic TypeScript projects using only relative imports** (`./`, `../`) - the dashboard handles standard TS transpilation automatically
- **Pure ESM or pure CJS projects without path aliases**
- Pre-built projects where workflows are already compiled to `.js`

## File Resolution

The dashboard automatically handles TypeScript transpilation:

| Scenario | File Used |
|---|---|
| Only `ed_workflows.ts` | Transpiled `.ts` on the fly |
| Only `ed_workflows.js` | `.js` directly |
| Both `.ts` and `.js` exist | `.ts` (preferred) |

**No manual build step required** — write your workflows in TypeScript, and the dashboard handles the rest.

## What the Dashboard Shows

### Workflow Functions
- **Function names** — all exported functions from `ed_workflows.ts`
- **Signatures** — function parameters and return types
- **Async indicator** — marks async vs sync functions
- **Source module** — where the function is imported from (if re-exported)
- **File path** — location in your codebase

### Tool Functions
- All exported functions from `ed_tools.ts`
- Same display format as workflows
- Used for agent task execution

## Search and Filter

Use the search field to filter by:
- **Name** — find workflow by function name (e.g., `checkoutFlow`)
- **Source module** — find all workflows from a specific module (e.g., `app.workflows`)
- **File path** — filter by location in your codebase

## Running Workflows

The dashboard provides an interactive workflow debugger:

### Step 1: Select Workflow
Choose a workflow function to run

### Step 2: Import Failed Trace
Upload a JSON trace file from a failed workflow run

### Step 3: Mark Broken Step
Select which observations (AI calls, tool calls) need fixing

### Step 4: Validate Fixes
Edit inputs, re-run individual observations, and compare outputs

### Step 5: Validate with Live Data
Run the entire workflow with live API calls to verify your fixes work end-to-end

## Fetching Traces from Langfuse

To import a trace into the dashboard, you need to fetch observation data from Langfuse's API using the correct trace ID.

### API Endpoint

```
https://cloud.langfuse.com/api/public/v2/observations?traceId=<TRACE_ID>&fields=time,io,basic,model
```

### Required Parameters

| Parameter | Description |
|---|---|
| `traceId` | The unique identifier for the trace (required) |
| `fields` | Comma-separated list of fields to include: `time,io,basic,model` (required) |

### Example Request

```bash
curl "https://cloud.langfuse.com/api/public/v2/observations?traceId=a1b2af2bc594eb816ab55a1d0c94fd47&fields=time,io,basic,model" \
  -H "Authorization: Basic <BASE64_ENCODED_CREDENTIALS>"
```

### Authentication

Use HTTP Basic Auth with a base64-encoded credential string:

1. **Create the credentials string:**
   ```
   <LANGFUSE_PUBLIC_KEY>:<LANGFUSE_SECRET_KEY>
   ```

2. **Encode to base64:**
   ```bash
   # On macOS/Linux:
   echo -n "<LANGFUSE_PUBLIC_KEY>:<LANGFUSE_SECRET_KEY>" | base64
   
   # Result: abc123def456...  (the base64 string)
   ```

3. **Use in the Authorization header:**
   ```bash
   -H "Authorization: Basic abc123def456..."
   ```

Bearer token auth is not accepted for this API usage.

### Using Postman

To fetch traces using Postman:

1. **Create a new GET request**
   - Set request type to `GET`
   - URL: `https://cloud.langfuse.com/api/public/v2/observations`

2. **Add query parameters:**
   - Click the "Params" tab
   - Add `traceId` parameter: `a1b2af2bc594eb816ab55a1d0c94fd47`
   - Add `fields` parameter: `time,io,basic,model`

3. **Add Authorization header:**
   - Click the "Auth" tab
   - Select `Basic Auth` from the Type dropdown
   - Username: `<LANGFUSE_PUBLIC_KEY>`
   - Password: `<LANGFUSE_SECRET_KEY>`
   - Postman will automatically base64-encode your credentials

4. **Send the request**
   - Click "Send"
   - The response will show the array of observations for your trace

**Alternatively, manually add the header:**
- Go to "Headers" tab
- Add header: `Authorization`
- Value: `Basic <BASE64_ENCODED_CREDENTIALS>`

### Example Response

The API returns an array of observation objects. Note that `input` and `output` fields are **stringified JSON** (not objects):

```json
[
  {
    "id": "1e31d1efb1aae8be",
    "traceId": "a1b2af2bc594eb816ab55a1d0c94fd47",
    "type": "GENERATION",
    "name": "OpenAI.chat",
    "startTime": "2026-03-01T10:02:06.132Z",
    "endTime": "2026-03-01T10:02:07.212Z",
    "model": "gpt-4o-2024-08-06",
    "input": "{\"messages\":[{\"role\":\"user\",\"content\":\"What is the order status?\"}]}",
    "output": "{\"role\":\"assistant\",\"content\":\"The order has been confirmed.\"}",
    "modelParameters": {
      "temperature": 0.7,
      "maxTokens": 500
    },
    "latency": 1.08,
    "level": "DEFAULT",
    "statusMessage": "",
    "parentObservationId": "40e8ae4d0f708886"
  },
  {
    "id": "dfe582e2934f570d",
    "traceId": "a1b2af2bc594eb816ab55a1d0c94fd47",
    "type": "TOOL",
    "name": "chargeCard",
    "startTime": "2026-03-01T10:02:07.215Z",
    "endTime": "2026-03-01T10:02:07.457Z",
    "model": "",
    "input": "{\"amount\":99.99,\"cardToken\":\"tok_visa1234\"}",
    "output": "{\"success\":true,\"transactionId\":\"txn-123\"}",
    "modelParameters": {},
    "latency": 0.242,
    "level": "DEFAULT",
    "statusMessage": "",
    "parentObservationId": "40e8ae4d0f708886"
  }
]
```

**Tip:** If you prefer not to manually encode, curl's `-u username:password` flag will automatically base64-encode your credentials, but the header format shown above is the official recommended approach.

**Reference:** See the [Langfuse Observations API documentation](https://langfuse.com/docs/api-and-data-platform/features/observations-api) for complete API details.

### Important Notes

**User Responsibility:** You must ensure that Langfuse correctly records the following fields for each observation:

- **`input`** — the input data for the observation (stringified JSON: messages for LLM calls, args for tool calls)
- **`output`** — the output/result from the observation (stringified JSON)
- **`model`** — the model name for AI calls (e.g., `gpt-4o-2024-08-06`, `gemini-pro`). Can be empty string for non-AI observations
- **`type`** — the observation type (`GENERATION` for LLM calls, `TOOL` or `SPAN` for tool calls)

**If these fields are missing or incorrect, the SDK dashboard may not function properly.** Verify your Langfuse instrumentation captures these fields before attempting to import traces.

**Note:** The `input` and `output` fields in Langfuse's API response are **stringified JSON strings**, not objects. The dashboard will parse these automatically.

### Uploading to Dashboard

Once you've fetched the JSON response from Langfuse:

1. Save the response to a `.json` file (e.g., `trace.json`)
2. Open the dashboard: `npx elasticdash dashboard`
3. Select a workflow to debug
4. Click "Import Failed Trace" and upload your JSON file
5. The dashboard will parse the observations and let you mark broken steps

## Configuration Files

Dashboard discovery uses `ed_workflows.ts` (workflow list) and `ed_tools.ts` (tool list). `ed_agents.ts` is used for agent-related dashboard flows. A project-specific `ed_workers.ts` file is optional and not consumed by dashboard discovery.

### `ed_workflows.ts`

Re-export workflow functions from your application:

```ts
// ed_workflows.ts
export { orderWorkflow, refundWorkflow } from './src/workflows'
export { userLookupFlow } from './src/user-flows'
```

**Important: Workflow Function Compatibility**

Dashboard replay executes exported workflow functions directly in a subprocess. Exported functions in `ed_workflows.ts/js` should:

- Be directly callable functions (not framework request handlers)
- Accept JSON-serializable input (object or array)
- Return JSON-serializable output (object or array)

Not directly compatible as workflow exports:

```ts
// Next.js route handler style
export async function POST(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ ok: true })
}
```

If your app uses framework handlers, create a plain workflow function and call it from the handler.

### `ed_tools.ts`

Re-export tool functions that agents or workflows can invoke:

```ts
// ed_tools.ts
import { runSelectQuery } from './src/services/dataService'

export const dataService = async (input: any) => {
  const { query } = input as { query: string }
  return await runSelectQuery(query)
    .then(async (res: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('dataService', input, res)
      } catch {
        // tracing must never block the main service path
      }
      return res
    })
    .catch(async (err: any) => {
      try {
        const { recordToolCall } = await import('elasticdash-test')
        recordToolCall('dataService', input, err)
      } catch {
        // tracing must never block the main service path
      }
      throw err
    })
}
```

**Important: Tool Function Compatibility**

Dashboard tool reruns execute exported tool functions directly in a subprocess. Exported functions in `ed_tools.ts/js` should:

- Be directly callable functions (not framework request handlers)
- Accept JSON-serializable input (object or array)
- Return JSON-serializable output (object, array, or primitive)

Not directly compatible as tool exports:

```ts
// Next.js route handler style
export async function POST(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ ok: true })
}
```

If your app uses framework handlers, create a plain tool function and call it from the handler.

#### Important: Tool Name and Input Matching

**Function names in `ed_tools.ts` must exactly match the tool `name` field in your Langfuse traces.** The dashboard uses this matching for step-level testing and trace replay.

Example:
- If Langfuse records a tool observation with `"name": "chargeCard"`
- Then your `ed_tools.ts` must export a function named `chargeCard`:
  ```ts
  export const chargeCard = async (input: any) => { ... }
  ```

**Function input must match exactly what was recorded in Langfuse:**
- The `input` parameter structure must match the `input` field in the Langfuse trace
- When using `recordToolCall`, pass the function's `input` parameter directly as the second argument:
  ```ts
  recordToolCall('chargeCard', input, result)  // ✅ Correct
  recordToolCall('chargeCard', input.amount, result)  // ❌ Wrong - partial input
  ```

If names or inputs don't match, step-level test assertions and dashboard replay features will not work correctly.

### `ed_agents.ts`

Re-export agent functions:

```ts
// ed_agents.ts
export { checkoutAgent, paymentAgent } from './src/agents'

// Or as a config object:
export const agents = {
  checkout: checkoutAgent,
  payment: paymentAgent,
}
```

## Usage in Tests

Access workflows from tests:

```ts
import { orderWorkflow } from './ed_workflows'

aiTest('full order workflow', async (ctx) => {
  const result = await orderWorkflow('order-123', 'cust-456')
  expect(ctx.trace).toCallTool('chargeCard')
})
```
