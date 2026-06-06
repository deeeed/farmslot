# OpenShell-Backed Slot Runtime Spike Plan

**Status:** Approved supporting plan for spike scoping
**Date:** 2026-06-06
**Relates to:** [ROADMAP-next](../ROADMAP-next.md), [ROADMAP](../ROADMAP.md), [PRD-runner-execution-canonical](../PRD-runner-execution-canonical.md), [ADR-023](../adr/023-runner-agnostic-tui-execution.md)
**Lifecycle:** Keep until the spike is either promoted into an ADR/PRD slice or closed as not worth integrating.

## Governance Checklist

- **Document type:** approved supporting plan under `docs/plans/`.
- **Why a new file:** OpenShell changes the slot runtime boundary; the research result is too detailed for the near-term roadmap and not yet accepted enough for an ADR.
- **Canonical support:** runner-agnostic execution and near-term runner/process reliability work.
- **Public-safety:** no private pool names, tokens, hostnames, project tickets, or local credentials.

## Research Result

OpenShell is feasible for Farmslot, but it should be evaluated as a **slot runtime sandbox backend**, not merely as another agent runner.

Farmslot already has a runner-aware launch seam: pool config can provide `dispatch_cmd`, gateway expands runner placeholders, and `buildLaunchCommand()` routes unknown/future runners through runner-aware templates. That seam is enough for a low-risk spike. Durable support is harder because OpenShell moves the real agent process and workspace effects inside a sandbox while Farmslot currently observes host-side tmux process trees, task files, `SIGNAL.json`, artifacts, and slot repos.

## OpenShell Facts to Assume for the Spike

- OpenShell uses a CLI/Gateway/Supervisor runtime model. The gateway owns sandbox lifecycle and policy; the supervisor runs inside the sandbox and launches the agent process under policy.
- Sandboxes support create, exec, connect, logs, upload, download, SSH config, and port/service forwarding.
- Claude Code is documented as working with default policy coverage. Codex is preinstalled but needs custom OpenAI endpoint and policy coverage.
- The upstream project currently describes itself as alpha/single-player mode, so Farmslot should treat it as an experimental backend until a real slot smoke proves stability.

Primary upstream references:

- <https://docs.nvidia.com/openshell/latest/about/how-it-works>
- <https://docs.nvidia.com/openshell/latest/sandboxes/manage-sandboxes>
- <https://docs.nvidia.com/openshell/latest/about/supported-agents>
- <https://github.com/NVIDIA/OpenShell>

## Farmslot Architecture Touchpoints

Read these before implementing the spike:

- `services/gateway/src/runners/launch-command.ts` — single source of truth for runner launch command construction.
- `services/gateway/src/runners/registry.ts` — runner capabilities, process matchers, safety flags, nudge behavior.
- `services/gateway/src/core/hooks.ts` — `dispatch_cmd` placeholder expansion.
- `services/gateway/src/methods/dispatch/execute.ts` — tmux dispatch, process-start verification, task prompt launch.
- `services/gateway/src/runners/session-process.ts` — descendant process checks under a tmux pane.
- `services/gateway/src/run-engine/run-monitor.ts` — `SIGNAL.json` and liveness monitoring.
- `services/gateway/src/run-engine/task-sync.ts` — host-to-slot task file sync.
- `scripts/deploy-node.sh` — node daemon deployment and per-machine dependency boundary.

## Spike Goal

Prove one non-mobile slot can run a Farmslot task through OpenShell and still produce the host-side completion evidence Farmslot expects.

The first success case is intentionally narrow:

1. Prepare a headless/test slot whose repo can be safely copied into an OpenShell sandbox.
2. Launch one supported agent inside OpenShell, preferably Claude first.
3. Ensure the task writes `.task/.../SIGNAL.json` and `artifacts/` inside the sandbox.
4. Sync those outputs back to the host slot repo.
5. Let Farmslot mark the run complete from normal host-side evidence without changing the monitor.

## Proposed Minimal Integration

### Phase 0 — Manual Smoke

Run OpenShell outside Farmslot on the target machine:

```bash
openshell gateway add http://127.0.0.1:18080 --local --name local
openshell gateway select local
openshell sandbox create --name farmslot-smoke -- claude
openshell sandbox upload farmslot-smoke ./some-safe-repo /workspace/repo
openshell sandbox exec -n farmslot-smoke --workdir /workspace/repo -- claude
```

Gate: agent can read a task, edit files, write a signal file, and download outputs.

### Phase 1 — Wrapper Dispatch Command

Add a local wrapper outside Farmslot core first, then point one pool entry at it with a runner-aware `dispatch_cmd`.

Example shape:

```json
{
  "dispatch_cmd": "cd {repo} && openshell-farmslot-dispatch {runner} {task_file}"
}
```

Wrapper responsibilities:

- derive a sandbox name from slot/run context available to the wrapper;
- create or reuse the sandbox;
- upload the task directory and any required repo snapshot;
- run the selected inner agent command;
- download `SIGNAL.json` and `artifacts/` back into the host task directory;
- keep an `openshell` process visible under tmux long enough for dispatch start checks.

If slot/run identity is not available in placeholders, start with a deterministic sandbox name based on repo basename and document the collision risk. Do not add new core placeholders until the wrapper proves value.

### Phase 2 — Experimental Runner Entry

If Phase 1 works, add an explicit experimental runner definition:

- `id: 'openshell'` or a clearer backend name such as `openshell-claude` if the inner runner matters;
- `processMatchers: ['openshell']`;
- `supportsTmuxNudges: false` until interactive control is proven;
- `persistsSessionFiles: false` unless OpenShell exposes stable host-visible session files;
- no special safety flags initially; OpenShell policy is a separate dimension from Farmslot safety tier.

### Phase 3 — First-Class Backend Decision

Promote to an ADR only if the wrapper demonstrates useful isolation or reproducibility. The ADR should decide whether OpenShell is:

1. a runner id,
2. a slot runtime backend orthogonal to runner id,
3. a project hook/setup option only, or
4. not a Farmslot-owned integration.

The current hypothesis is option 2.

## Acceptance Criteria

- One OpenShell-backed headless slot completes a Farmslot task from normal dispatch entry points.
- The host slot repo contains fresh `SIGNAL.json` and `artifacts/` after sandbox completion.
- Farmslot does not falsely mark the run done while the sandbox agent is still active.
- Operator logs clearly show OpenShell sandbox name, inner runner, and sync steps.
- No mobile/device slot claims are made.
- A follow-up decision is recorded: promote to ADR, keep as wrapper-only, or close.

## Explicit Non-Goals

- Do not change mobile simulator, ADB, CDP, or capture-helper paths in the first spike.
- Do not require Kubernetes or remote gateway deployment.
- Do not make OpenShell policy equivalent to Farmslot safety tiers.
- Do not rewrite `deploy-node.sh` until the wrapper proves useful.
- Do not claim Codex support until OpenAI provider/policy setup is smoked inside OpenShell.

## Known Risks

- **Workspace split:** Farmslot watches the host repo; OpenShell writes inside `/workspace` or `/sandbox` unless synced back.
- **Process detection:** Farmslot checks runner descendants under tmux; the host process may be `openshell`, not the inner agent.
- **Interactive control:** tmux nudges may not reach the inner agent reliably.
- **Device access:** mobile slots likely need host simulator/ADB/CDP access that sandbox policy may block.
- **Credential routing:** Codex and other agents may require provider/policy setup that differs from existing host credentials.

## ADR Promotion Questions

Before writing an ADR, answer:

1. Should Farmslot model sandbox backend separately from runner id?
2. Where should sandbox identity live: pool slot config, run metadata, runtime dir, or wrapper convention?
3. Which files must be mirrored back for completion, review, eval, and artifact package flows?
4. How should liveness be detected: host `openshell` process, OpenShell sandbox phase, inner agent process, or `SIGNAL.json` only?
5. Is OpenShell valuable for production Farmslot slots, or only for isolated research/eval tasks?
