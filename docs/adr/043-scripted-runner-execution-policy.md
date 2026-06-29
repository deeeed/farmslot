# ADR-043: Scripted Runner and Per-Step Executor Policy

**Status:** Proposed  
**Date:** 2026-06-29  
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-023](023-runner-agnostic-tui-execution.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-030](030-replay-provenance-and-reference-evals.md), [ADR-034](034-recipe-protocol-v1.md), [ADR-040](040-work-graph-orchestration.md), [PRD Runner Execution](../PRD-runner-execution-canonical.md), [PRD Automation Intelligence](../PRD-automation-intelligence-canonical.md), [ROADMAP-next](../ROADMAP-next.md)

## Context

Farmslot needs a fast, safe way to validate full dispatch flows in development without burning real LLM time for every worker step. The current partial `fake` runner shape is not enough:

- the runner id is framed as fake instead of as a legitimate non-LLM executor
- gateway launch currently risks resolving a global or registry `farmslot` binary instead of the checkout under test
- there is no registered CLI command for the existing fake launch path
- dev validation, project-owned command execution, self-review policy, and manual/external blockers are not cleanly separated
- work graphs and backlog dispatch need end-to-end validation that exercises the real queue, run state machine, scheduler, and artifacts

At the same time, ADR-023 requires runner behavior to remain capability-based, ADR-024 requires lanes/families to stay coherent, ADR-030 uses artifact-only comparison lanes for evals, and ADR-040 routes graph execution through backlog and the existing dispatch queue. The validation executor should compose with those decisions instead of creating another side channel.

## Decision

Introduce one configurable non-LLM runner named **`scripted`** and a small executor-policy vocabulary for per-step run configuration.

### 1. Replace the fake runner concept with `scripted`

`scripted` is a real runner id, not a testing hack. It executes deterministic scenarios or project-owned commands through the same dispatch/run/monitor path as other runners.

The existing `fake` id becomes legacy implementation debt to remove or alias during migration. New UI, protocol, docs, and tests should use `scripted`.

### 2. `scripted` has two v1 modes

```ts
type ScriptedRunnerMode = 'scenario' | 'command';

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

- **Scenario mode** is deterministic dev/e2e simulation. It writes the same task artifacts and completion signals that real flows expect, but does not call an LLM. It is allowed only when `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1` is set.
- **Command mode** executes a project-owned command reference from project config. It is allowed outside dev when the command is explicitly declared by the project.

No arbitrary shell string may be accepted from the UI or RPC request in v1.

### 3. Do not add a manual runner

Manual and external work are graph/backlog/reference state, not runners. ADR-040 reference nodes cover external Jira issues, external PRs, release gates, package-publish milestones, and other blockers that Farmslot should observe but not execute.

If Farmslot should own the work, the operator creates a backlog item with acceptance criteria and dispatch config, then runs it with an executor such as `claude`, `codex`, or `scripted`.

### 4. Top-level `runner` remains the worker executor shorthand

Existing APIs and backlog specs may keep using:

```ts
runner: 'claude' | 'codex' | 'scripted' | ...
model?: string;
```

That remains shorthand for the **worker** step. It must not imply the same executor for self-review, CI repair, publication review, or future validation steps.

### 5. Add explicit per-step executor policy where needed

When a flow needs different executors for different steps, use an additive policy object:

```ts
type ExecutorPolicy = {
  worker?: ExecutorRef;
  selfReview?: ExecutorRef;
  ciRepair?: ExecutorRef;
  validation?: ExecutorRef;
};

type ExecutorRef = {
  runner: string;
  model?: string;
  scripted?: ScriptedRunnerConfig;
  safetyTier?: 'sandboxed' | 'full-auto' | 'dangerous';
};
```

V1 should implement only the fields required by current dispatch flows: worker execution plus compatibility with existing self-review runner/model config. Do not build a broad generic `executionPlan.steps[]` scheduler until a real flow requires it.

### 6. Gateway launch must use the checkout-local CLI

Gateway-created scripted commands must never use `npx farmslot`, a bare `farmslot` binary, or any other PATH-dependent launcher.

The launch contract is:

```sh
FARMSLOT_ROOT=<gateway checkout> \
node <gateway checkout>/packages/cli/bin/farmslot.mjs scripted-runner ...
```

The CLI must print provenance at start:

- CLI entrypoint path
- `FARMSLOT_ROOT`
- package version
- git SHA, when available
- scripted mode/scenario/commandRef

E2E validation must assert that the runner provenance matches the gateway checkout under test.

### 7. Scenario mode is validation-lane friendly, not production magic

Scenario mode is for validating Farmslot itself: dispatch, queueing, backlog, work graphs, run status transitions, artifact handling, failure handling, and UI surfaces. It should normally run in ADR-024 `lane: 'validation'` or `lane: 'comparison'` with artifact-only policy when used for eval harness checks.

Production work should use real LLM runners or project-owned command mode. Scenario mode must not silently bypass acceptance criteria or mark real implementation work complete.

## Consequences

**Positive:**

- Fast end-to-end validation can exercise the real dispatch path without LLM cost.
- Project-owned command execution has one home instead of separate fake/command/manual runners.
- Work graph and backlog scheduler tests can prove dependency behavior with deterministic nodes.
- Self-review can still use an LLM even when the first worker step is scripted.
- Checkout-local launch avoids stale installed CLI bugs.

**Negative:**

- Runner config needs one more branch for `scripted` mode validation.
- Scenario artifacts can create false confidence if tests do not also cover real runner paths.
- Command mode needs careful project-config validation to avoid becoming arbitrary shell execution.

**Risks:**

- Operators may try to use scenario mode as a production shortcut. The env flag, lane guidance, UI copy, and provenance should make this hard to do accidentally.
- Per-step executor policy could become over-engineered. V1 must stay narrow: worker + existing review-step compatibility only.

## Implementation Scope

Implement this through the plan in [scripted-runner-dispatch-e2e-v1](../plans/scripted-runner-dispatch-e2e-v1.md).

V1 should include:

1. runner registry entry for `scripted`
2. CLI `scripted-runner` command
3. checkout-local launch builder
4. feature-gated scenario mode
5. project-owned commandRef mode
6. protocol/config validation
7. dispatch/run e2e tests for success and failure
8. worker-scripted plus self-review-LLM compatibility test or fixture

V1 should not include:

- a separate manual runner
- arbitrary shell entry from UI/RPC
- a generic multi-step execution DAG
- graph scheduler implementation beyond what is already accepted in ADR-040 work
- production use of scenario mode

## Validation Guidance

Minimum validation before accepting the implementation:

- unit: launch command never contains `npx farmslot` or bare `farmslot`
- unit: scenario mode rejects without `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1`
- unit: command mode rejects undeclared `commandRef`
- e2e: scripted scenario success reaches terminal success with expected artifacts
- e2e: scripted scenario failure reaches terminal failure, not false success
- e2e: scripted command failure preserves command exit evidence
- e2e: worker `scripted` can coexist with an LLM self-review policy
- provenance: e2e asserts CLI path/SHA matches the gateway checkout

## Alternatives Considered

### Keep `fake` as the runner id

Rejected. The name makes the concept feel disposable and keeps dev validation separate from legitimate non-LLM project commands.

### Add separate fake, command, and manual runners

Rejected. It fragments one concern into three executor identities. Manual/external work is better modeled as backlog/work-graph/reference state.

### Allow arbitrary command strings from dispatch requests

Rejected for v1. Project-owned `commandRef` preserves flexibility without letting UI/RPC become a shell injection surface.

### Implement generic `executionPlan.steps[]` now

Rejected for v1. Current needs are worker executor selection plus existing review/CI follow-up configuration. A generic step DAG should wait for concrete flows that prove the shape.
