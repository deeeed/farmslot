# Scripted Runner Dispatch E2E v1

**Status:** Draft for review  
**Supports:** [ADR-043](../adr/043-scripted-runner-execution-policy.md), [ADR-023](../adr/023-runner-agnostic-tui-execution.md), [ADR-024](../adr/024-run-lanes-and-run-family-model.md), [ADR-034](../adr/034-recipe-protocol-v1.md), [ADR-040](../adr/040-work-graph-orchestration.md), [ROADMAP-next](../ROADMAP-next.md)  
**Lifecycle:** Promote into implementation PR, then delete or mark shipped once the runner and E2E harness land.

## Goal

Add a checkout-local `scripted` runner that can validate Farmslot dispatch flows end-to-end without requiring an LLM worker for every test. The runner must exercise the real gateway queue, run state machine, task artifacts, and completion handling.

## Non-goals

- Do not implement a separate `manual` runner.
- Do not accept arbitrary shell commands from UI or RPC.
- Do not build a generic multi-step execution DAG.
- Do not implement ADR-040 graph scheduling in this slice.
- Do not use global `farmslot`, `npx farmslot`, or PATH-dependent launch.

## Current Problem

The repo has partial fake-runner seams, but they are not safe or complete:

- runner registry has a `fake` id
- launch code points at `npx farmslot fake-runner ...`
- the CLI does not expose a matching `fake-runner` command
- demo/QA docs drifted from current pool state
- there is no reliable dev-only scenario gate
- there is no commandRef path for project-owned non-LLM validation

This leaves dispatch/workgraph/backlog flows hard to validate quickly and increases the chance of accidentally testing an old installed CLI.

## Proposed Shape

### Runner ids

- Add `scripted`.
- Remove `fake` as a public runner spelling; do not add a compatibility alias in new code.

### Protocol/config

Add or extend shared types so dispatch config can express:

```ts
type ExecutorRef = {
  runner: string;
  model?: string;
  scripted?: ScriptedRunnerConfig;
  safetyTier?: SafetyTier;
};

type ScriptedRunnerConfig =
  | {
      mode: 'scenario';
      scenario: 'success' | 'failure' | 'timeout';
      stepDelayMs?: number;
    }
  | {
      mode: 'command';
      commandRef: string;
      timeoutMs?: number;
    };
```

Compatibility rule: existing top-level `runner` / `model` maps to `executorPolicy.worker` internally when no explicit policy is provided.

### Project config

Project-owned commands live in project config, not in request payloads:

```json
{
  "scripted": {
    "commands": {
      "smoke": {
        "command": "yarn test:smoke",
        "timeout_ms": 120000
      }
    }
  }
}
```

Implementation notes:

- Resolve `commandRef` by project and reject unknown refs.
- Execute from the project repo root unless a project config field explicitly says otherwise.
- Preserve stdout/stderr and exit code as run artifacts.
- Treat non-zero exit as run failure.

### Scenario mode

Scenario mode should write deterministic artifacts that mirror a real worker enough for gateway/UI validation:

- `SIGNAL.json` or current completion signal expected by the flow
- `report.md`
- minimal run/step evidence files used by UI surfaces
- provenance file with mode, scenario, CLI path, root, version, and SHA

Scenarios:

- `success`: emits expected artifacts and exits 0
- `failure`: emits failure evidence and exits non-zero
- `timeout`: sleeps past the configured timeout or emits no terminal signal, depending on the test case

Scenario mode requires `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1`.

### Gateway launch

Replace unsafe launch with checkout-local CLI invocation:

```sh
FARMSLOT_ROOT="$PWD" \
node "$PWD/packages/cli/bin/farmslot.mjs" scripted-runner \
  --task-dir <taskDir> \
  --mode scenario \
  --scenario success
```

Rules:

- never emit `npx farmslot`
- never emit bare `farmslot`
- quote paths safely using the repo's existing shell quoting helper
- include enough env to prove which checkout is under test

### CLI command

Add:

```sh
farmslot scripted-runner --task-dir <path> --mode scenario --scenario success
farmslot scripted-runner --task-dir <path> --mode command --project <project> --command-ref smoke
```

The command should be intentionally small: parse config, run the scripted mode, write artifacts, and exit with the intended status.

### Self-review compatibility

A run may use:

```json
{
  "executorPolicy": {
    "worker": { "runner": "scripted", "scripted": { "mode": "scenario", "scenario": "success" } },
    "selfReview": { "runner": "codex", "model": "<configured-model>" }
  }
}
```

V1 only needs to preserve or map existing self-review runner/model config. Do not invent a full step scheduler.

## Implementation Steps

1. **Type/protocol pass**
   - Add `scripted` to runner enums/types.
   - Add `ScriptedRunnerConfig` and narrow validation helpers.
   - Add compatibility mapping from top-level `runner`/`model` to worker executor where needed.

2. **Runner registry and launch**
   - Register `scripted` with exec launch mode and honest capabilities.
   - Replace the existing fake launch special case.
   - Add tests proving launch uses checkout-local `node .../packages/cli/bin/farmslot.mjs`.

3. **CLI scripted-runner command**
   - Implement scenario success/failure/timeout.
   - Implement commandRef execution by loading project config through existing project resolution utilities.
   - Emit provenance and artifacts.

4. **Gateway validation**
   - Reject scenario mode unless `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1`.
   - Reject command mode when `commandRef` is missing or undeclared.
   - Reject inline command strings.

5. **E2E harness**
   - Add a dev-only test fixture/project command if needed.
   - Dispatch scripted scenario success and assert terminal success.
   - Dispatch scripted scenario failure and assert terminal failure.
   - Dispatch commandRef failure and assert exit evidence.
   - Assert runner provenance matches the checkout SHA.

6. **Docs cleanup**
   - Replace stale fake-runner QA docs with scripted-runner validation docs.
   - Update local demo docs only if demo slots/config are made accurate in the same PR.

## Acceptance Criteria

- `scripted` is the only new public runner concept.
- Existing `fake` runner references are removed from public runner selection and launch paths.
- Gateway launch never uses global/path-resolved Farmslot.
- Scenario mode cannot run unless explicitly enabled by env.
- Command mode can only run declared project command refs.
- Non-zero scripted command exits fail the run with visible evidence.
- Scripted worker can coexist with separate self-review runner/model config.
- The E2E harness proves success and failure through the real dispatch path.
- Docs explain when to use scenario mode vs command mode.

## Validation Commands

Expected implementation PR validation should use real package scripts added or reused during implementation. Minimum command families:

```sh
yarn workspace @farmslot/protocol build
yarn workspace @farmslot/cli typecheck
yarn --cwd apps/command-center typecheck
# plus the new scripted-runner unit/e2e scripts added by the implementation PR
```

Do not document placeholder root test commands as accepted validation. Add explicit package scripts when the tests are implemented.

## Open Questions Before Coding

1. Should scenario artifacts use the exact current worker template artifact names, or a minimal stable runner-validation artifact set?
2. Which CI job should own the scripted dispatch E2E: repo quality, gateway quality, or a separate optional/dev job?
