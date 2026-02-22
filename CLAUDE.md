# CLAUDE.md

## Repository Overview

This repository contains the source code for the `elasticdash-test` JavaScript/TypeScript SDK and test runner. The SDK provides utilities for AI-native workflow testing, including custom Jest/Expect matchers, trace recording, and integration with LLM and tool call workflows. It is designed to help developers write, run, and validate tests for AI-driven applications and workflows.

## Repository Structure

```
elasticdash-test-js/
  CLAUDE.md
  README.md
  LICENSE
  elasticdash.config.ts
  package.json
  tsconfig.json
  .claude/                # assistant metadata
  .temp/                  # working artifacts (e.g., plan.md)
  dist/                   # build output
  docs/
    test-writing-guidelines.md
  examples/
    simple.ai.test.ts
    tsconfig.json
  src/
    browser-ui.ts
    cli.ts
    core/
    index.ts
    interceptors/
    matchers/
    reporter.ts
    runner.ts
    test-setup.ts
    trace-adapter/
    types/
```

## Claude Code Contribution Policy

To ensure safe and maintainable contributions from Claude (or any AI assistant), the following workflow **must** be followed for any code modification or addition:

### 1. Planning Phase

- **Claude must first create and present a clear, step-by-step plan** for any requested change, feature, or fix.
- The plan should include:
  - A summary of the intended change or feature.
  - A list of files to be created or modified.
  - A brief description of the changes to each file.
  - Any potential side effects or considerations.
- The plan should be saved in .temp/plan.md. If the file already exists, overwrite it by replace all its old content with new content.

### 2. Approval Phase

- **No code changes may be made until the plan is explicitly approved by a human maintainer.**
- The maintainer will review the plan and may request clarifications or modifications before approval.

### 3. Implementation Phase

- Once the plan is approved, Claude may proceed to implement the changes as described in the plan.
- All code changes should reference the approved plan and adhere strictly to its steps.
- If any deviation from the plan is required, Claude must stop and request further approval with an updated plan.

### 4. Review Phase

- After implementation, Claude should summarize the changes and highlight any differences from the original plan.
- The maintainer will review the changes before merging or further action.

---

**Summary:**  
Claude must always present a plan and wait for explicit approval before making any code changes in this repository.

---