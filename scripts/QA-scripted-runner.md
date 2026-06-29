# QA: Scripted Runner Dispatch E2E

Use this when you need a fast, non-LLM proof that Farmslot dispatch can launch a worker, write `SIGNAL.json`, and surface success/failure artifacts.

## Automated dispatch E2E

From the repo root:

```bash
yarn e2e:scripted-runner
```

What it does:

- creates a temporary local pool slot and tmux session
- dispatches `runner=scripted` through `dispatch.execute`
- runs both `success` and `failure` scenarios
- asserts the launch command uses checkout-local CLI, not `npx farmslot` or global `farmslot`
- waits for worker `SIGNAL.json` and verifies success/failure outcomes
- cleans up the temporary pool file, tmux session, task source, and worker `.task/` output

Expected output:

```text
scripted success: complete/success
scripted failure: failed/failure
```

## Manual gateway run

Scenario mode is dev-only and must be explicitly enabled:

```bash
cd apps/command-center
FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1 yarn farmslot run create \
  --project farmslot-farm \
  --flow-type dev \
  --ticket "scripted validation smoke" \
  --mode validation \
  --runner scripted \
  --scripted-scenario success \
  --scripted-step-delay-ms 500
```

For command mode, add project-owned refs under `projects/<project>/project.json`:

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

Then run:

```bash
cd apps/command-center
yarn farmslot run create \
  --project farmslot-farm \
  --flow-type dev \
  --ticket "scripted command smoke" \
  --mode validation \
  --runner scripted \
  --scripted-command-ref smoke
```

## Pass/fail checklist

- [ ] run reaches expected terminal outcome
- [ ] launch command includes `node "$PWD/packages/cli/bin/farmslot.mjs" scripted-runner`
- [ ] launch command does not include `npx farmslot` or bare `farmslot`
- [ ] `SIGNAL.json` exists in the worker task directory
- [ ] `artifacts/report.md` and `artifacts/scripted-runner-provenance.json` exist
- [ ] command mode only uses a declared `scripted.commands` ref
