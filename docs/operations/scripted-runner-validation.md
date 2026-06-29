# Scripted Runner Validation Workflow

Use the `scripted` runner when validating Farmslot orchestration itself and the worker does not need an LLM turn.

## When to use it

Good fits:

- dispatch/run lifecycle smoke tests
- backlog-to-dispatch validation
- work-graph dependency validation
- UI flows that need a fast terminal run
- failure-path validation without spending LLM time

Do not use it to claim production implementation work is complete. Scenario mode is a simulator.

## Automated E2E command

For PR validation, prefer the repo-local dispatch E2E command when tmux is available:

```sh
yarn e2e:scripted-runner
```

This creates a temporary local pool slot, dispatches success and failure scenarios through `dispatch.execute`, verifies the checkout-local launch command, waits for worker `SIGNAL.json`, and cleans up after itself. Use this before claiming scripted-runner dispatch integration works end-to-end.

## Scenario mode

Scenario mode is dev/e2e only and requires an explicit env flag:

```sh
export FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1
```

Create a validation run through the normal run path:

```sh
cd apps/command-center
FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1 yarn farmslot run create \
  --project farmslot-farm \
  --flow-type dev \
  --ticket "scripted validation smoke" \
  --mode validation \
  --runner scripted \
  --scripted-scenario success \
  --scripted-step-delay-ms 0
```

Useful scenarios:

- `success` — writes `SIGNAL.json` with success
- `failure` — writes failure artifacts and exits non-zero
- `timeout` — exercises timeout/failure handling

## Command mode

Command mode runs a project-owned command reference. Define commands in `projects/<project>/project.json`:

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

Then dispatch:

```sh
cd apps/command-center
yarn farmslot run create \
  --project farmslot-farm \
  --flow-type dev \
  --ticket "scripted command smoke" \
  --mode validation \
  --runner scripted \
  --scripted-command-ref smoke
```

The gateway rejects undeclared `commandRef` values. Do not pass arbitrary shell from UI/RPC.

## Invariants for agents

- Use workspace-local CLI: `cd apps/command-center && yarn farmslot ...`.
- Never use global `farmslot` or `npx farmslot` for validation.
- `runner=scripted` requires `scripted` config.
- Scenario mode requires `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1`.
- Command mode must resolve through project config.
- The launched worker command uses checkout-local CLI:
  `FARMSLOT_ROOT="$PWD" node "$PWD/packages/cli/bin/farmslot.mjs" scripted-runner ...`.

## Artifacts

The scripted worker writes into the worker task directory:

- `SIGNAL.json`
- `artifacts/report.md`
- `artifacts/scripted-runner-provenance.json`
- command mode also writes stdout/stderr/result artifacts

Use these artifacts when proving success/failure in PR validation notes.
