# Using elasticdash-test in Deno

This guide shows how to add, pin, and run `elasticdash-test` inside a Deno project for AI workflow tests.

## 1) Add the dependency via import map

In your package `deno.json` (e.g., `packages/api/deno.json`), add an import mapping and a test task. Example pinned to 0.1.8:

```json
{
  "tasks": {
    "test": "deno run -A --env-file=../../.env npm:elasticdash-test@0.1.8 test tests"
  },
  "imports": {
    "elasticdash-test": "npm:elasticdash-test@0.1.8"
  }
}
```

If registry integrity issues block 0.1.8, use the last known good build, e.g. `npm:elasticdash-test@0.1.6-alpha-2`, and mirror that in the task command.

## 2) Cache (optional, for reproducibility/offline)

From the package directory (e.g., `packages/api`):

```bash
deno cache --reload npm:elasticdash-test@0.1.8
```

If you hit a checksum mismatch, switch to the pinned fallback version (e.g., `0.1.6-alpha-2`) and cache that instead.

## 3) Write a test

Create a test file under `tests/` ending with `.ai.test.ts` or `.ai.test.js` and import the setup:

```javascript
import "npm:elasticdash-test/dist/test-setup.js"
import { expect } from "npm:elasticdash-test"

aiTest("example", async () => {
  expect(1 + 1).toBe(2)
})
```

For API router testing with optional live OpenAI calls, see the existing example at `packages/api/tests/router.ai.test.js`.

## 4) Run tests

From your package directory:

- Stubbed/deterministic mode (default):
  ```bash
  deno task test
  ```

- Live mode (hits OpenAI):
  ```bash
  RUN_LIVE_OPENAI=1 deno task test
  ```

Ensure `OPENAI_API_KEY` is available (e.g., via `.env` loaded by `--env-file`).

## 5) Troubleshooting

- **Checksum mismatch when caching**: use the fallback version that matches your import map (e.g., `0.1.6-alpha-2`) and rerun `deno cache --reload npm:elasticdash-test@...`.
- **Command not found**: ensure you run tasks from the package folder where `deno.json` defines `test`.
- **Missing env vars**: confirm `.env` is loaded via `--env-file` or exported in your shell.
