# Farmslot unified project + multi-surface validation plan

**Owner:** Arthur / Farmslot
**Status:** Approved supporting plan (Phases A–D shipped)
**Last updated:** 2026-06-27
**Relates to:** [ROADMAP-next.md](../ROADMAP-next.md), [PRD-core-farmslot-canonical.md](../PRD-core-farmslot-canonical.md), [PRD-command-center-canonical.md](../PRD-command-center-canonical.md), [PRD-mobile-companion-canonical.md](../PRD-mobile-companion-canonical.md), [plans/farmslot-self-dogfood-day.md](farmslot-self-dogfood-day.md), [plans/generic-recipe-protocol.md](generic-recipe-protocol.md), [operations/worktree-operator-model.md](../operations/worktree-operator-model.md)

## Problem

Farmslot dogfood formerly split across two project configs (`farmslot-farm`, `farmslot-companion`) while sharing one monorepo and one product roadmap. That fragments backlog, runs, dispatch defaults, and operator mental model. Cross-surface tasks (gateway + Command Center + Companion) do not map cleanly to a single `app` or `prepareProfile`.

## Goal

1. **One canonical project** — `farmslot` — for all first-party dogfood dispatch, backlog, and run history.
2. **App + prepare profile selection** — `command-center` vs `companion` surfaces with MM-style warm/full profiles on the mobile lane.
3. **Validation plan** — when a ticket needs proof on multiple surfaces, classify a **plan** (primary prepare + validation steps), not a single enum.
4. **Dispatch safety** — extend the existing project-fit pattern to intra-project profile/app fit and multi-surface warnings.

## Non-goals (v1)

- Merging MetaMask or third-party farms into `farmslot`.
- Automatic prepare without operator confirmation when confidence is below `high`.
- Per-SHA native build cache or worktree-per-branch (ADR-030/ADR-024 non-goals stand).
- Rewriting accepted ADRs; add follow-up addenda or a new ADR only if schema/RPC shape requires it.

## Target model

### Single project config

```
projects/farmslot/project.json
  name: farmslot
  apps: ["command-center", "companion"]
  worktree_base: farmslot-wt (one base)
  prepare.profiles:
    sandbox, attach, typecheck          # gateway / CC (current farmslot)
    companion-warm, companion-full      # Metro + dev client (MM ensure-js / full analogue)
    stack-dogfood (optional composite)  # gateway sandbox + companion warm — operator-only shortcut
```

Pool slots keep heterogeneous resources under `project: "farmslot"`:

- `macwork-fs-main`, `macwork-ff-*` — `platform: cli`, gateway port
- Future `macwork-fc-*` — `platform: ios`, Metro + simulator

### Validation plan (run metadata or task artifact)

For tickets that span surfaces:

```jsonc
{
  "primaryPrepareProfile": "sandbox",
  "validation": [
    { "surface": "command-center", "kind": "cdp", "route": "#runs" },
    { "surface": "gateway", "kind": "rpc", "method": "run.list" },
    { "surface": "companion", "kind": "recipe", "recipe": "mobile-companion.recipe.json", "prepareProfile": "companion-warm", "slot": "macwork-fc-1" }
  ]
}
```

**Rules:**

- Gateway prepare is the default primary stack (Companion and CC consume the gateway).
- Companion native prepare is additive when AC/labels/paths require device proof.
- Multi-slot tasks pair gateway sandbox (e.g. `ff-2` @8809) with companion mobile slot pointed at that gateway URL.

Existing multi-recipe shape: [docs/examples/recipes/farmslot/self-validation-suite.json](../examples/recipes/farmslot/self-validation-suite.json).

## Classifier lanes

### 1. Inter-project fit (shipped)

`services/gateway/src/run-engine/project-fit-gate.ts` at `WRITE_TASK`:

- Jira prefix / GitHub repo → candidate **projects**
- LLM + deterministic metadata → `project_mismatch` human gate

**After unified `farmslot`:** still needed between `farmslot` and `metamask-mobile-farm`, etc. Not replaced.

### 2. Profile / app fit (new — extends ADR-037 deferred auto-selection)

When `run.project === 'farmslot'` (or single first-party project):

- Inputs: ticket metadata, `flowType`, current `app`, `prepareProfile`, slot `platform` + resources, profile catalog (`label`, `description` from `project.json`).
- Deterministic token match first (same haystack pattern as project-fit).
- Optional LLM (3.5s cap, advisory) when ambiguous.
- Human gate: `prepare_profile_mismatch` / `validation_plan_suggestion` (mirror `project_mismatch`).

**Explicit operator choices win** — do not override `prepareProfile` or `app` when already set.

### 3. Multi-surface detection

Classifier emits `validation[]` when ticket mentions companion + gateway/ui/protocol. Wizard shows the matrix before enqueue; `WRITE_TASK` confirms or lets operator edit.

## ADR and plan integration matrix

| Artifact | Relationship | Action |
| -------- | ------------ | ------ |
| [ADR-037](../adr/037-prepare-profiles.md) | **Primary home** for profile catalog, `requires`/`fallback`, `FARMSLOT_PREPARE_PROFILE`. Explicitly defers *automatic* profile selection and per-flow-type default map. | Implement profile-fit + optional per-app default map as **ADR-037 follow-up** (addendum or short ADR-041 if RPC adds `validationPlan`). Update [adr-implementation-status.md](../reference/adr-implementation-status.md) row "Auto cheapest-profile selection". |
| [ADR-024](../adr/024-run-lanes-and-run-family-model.md) §7 | `run.activateOnSlot` already picks cheapest profile (`attach` → `ensure-js-runtime` → `full`). | Reuse chain for `farmslot` profiles; extend activate path when `slotId` omitted / released-slot affinity (already on ROADMAP-next). |
| [ADR-039](../adr/039-run-portable-bundles.md) | Worktree sandboxes + bundle seed. | No change; unified project simplifies `project` field on export/import. Align [worktree-operator-model.md](../operations/worktree-operator-model.md) examples to `project: farmslot`. |
| [ADR-034](../adr/034-recipe-protocol-v1.md) | Self-validation suite spans CC, gateway RPC, companion. | Validation plan `kind: recipe` references suite entries; ties to ROADMAP-next recipe adoption item #2. |
| [ADR-036](../adr/036-cli-onboarding.md) | Companion pack portability + pairing. | Companion validation steps assume gateway URL from slot; no ADR change. |
| [ADR-033](../adr/033-mobile-tmux-worker-control.md) | Companion as gateway client. | Validation plan treats Companion as proof surface, not separate product. |
| [ADR-007](../adr/007-project-structure.md) | Monorepo + `apps` in schema. | Unified `farmslot` project is the intended use of `project.json` `apps` + `{{app}}` hooks. |
| [ADR-031](../adr/031-deterministic-first-auto-recovery.md) | Deterministic classifier before LLM. | Reuse pattern for profile-fit; audit/recovery can consume `validationPlan` misses later. |
| **Project-fit gate (code, no ADR)** | Shipped in `project-fit-gate.ts` / `task-steps.ts`. | Document in this plan; optional one-paragraph cross-reference in ADR-037 addendum ("inter-project fit gate"). |
| [generic-recipe-protocol.md](generic-recipe-protocol.md) | Phase 4 self-validation suite. | Multi-surface validation plan is the **dispatch/prepare** complement to recipe suite **evidence**. |
| [farmslot-self-dogfood-day.md](farmslot-self-dogfood-day.md) | Uses `project: farmslot`. | Update examples to `farmslot` when migration lands. |
| [companion-ui-architecture-refactor.md](companion-ui-architecture-refactor.md) | UI structure only. | Orthogonal; no blocker. |

**Not planned elsewhere (gap this plan fills):**

- Merging `farmslot` + `farmslot` project configs.
- Intra-project profile/app classifier.
- Multi-surface validation plan on runs/tasks.
- Companion `ensure-js-runtime` / `full` prepare profiles on unified project.

**Already planned — do not duplicate:**

- ADR-037 auto profile selection (deferred) — this plan **is** that follow-up, scoped to `farmslot`.
- Recipe self-validation execution (ROADMAP-next #2).
- ADR-036 companion pack portable (ROADMAP-next #10).
- Activate-on-slot warm-auto-pick (ROADMAP-next captured under ADR-024).

## Implementation phases

### Phase A — Project merge (config only)

- Add `projects/farmslot/project.json` (merge hooks, prepare profiles, fixtures, templates).
- Pool: `project: "farmslot"` on fs/ff slots.
- Update recipes/docs/tests to use `farmslot` only (no legacy name aliases).

### Phase B — Profile catalog

- Gateway: `sandbox`, `attach`, `typecheck`.
- Companion: `companion-warm`, `companion-full` (hooks in `apps/companion/scripts/agentic/`).
- Optional `stack-dogfood` composite script under `projects/farmslot/setup/`.

### Phase C — Profile-fit gate

- `profile-fit-gate.ts` + tests; wire in `task-steps.ts` after project-fit.
- Dispatch wizard preview shows suggestion.
- Protocol: optional `validationPlan` on `Run` or task artifact schema (only if needed for UI persistence).

### Phase D — Dogfood proof

Cross-surface proof matrix (manual, one run family):

```bash
# 1. Gateway sandbox on ff-2
farmslot slot prepare macwork-ff-2 --prepare-profile stack-dogfood

# 2. Command Center CDP
node apps/command-center/scripts/cdp.mjs eval '#runs' "document.title"

# 3. Gateway RPC
node apps/command-center/scripts/cdp.mjs gateway run.list '{}'

# 4. Companion recipe (mobile slot or device-pinned agentic.local.conf)
farmslot slot prepare macwork-fc-1 --prepare-profile companion-warm
# hooks.recipe_run via docs/examples/recipes/farmslot/mobile-companion.recipe.json
```

Evidence: run ids + recipe artifacts under `.sandbox/farmslot/`.

## Success criteria

- Single backlog project `farmslot`; Companion filters without a second project name.
- Dispatch warns when companion ticket uses gateway-only `sandbox` without validation plan.
- Cross-surface task produces explicit validation matrix in task or run metadata.
- MM-style warm prepare default for companion; `full` only for native/port drift.

## Open decisions

1. **New ADR vs ADR-037 addendum** — addendum unless `validationPlan` RPC requires protocol bump.
2. **Run field vs task-only validation plan** — prefer task artifact + dispatch preview v1; promote to `Run` when Companion must show it live.
3. **Legacy project dirs** — remove `projects/farmslot-farm` and `projects/farmslot-companion` from the repo once pool/operators are migrated.