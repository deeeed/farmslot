# Update-Branch Flow Rename Implementation Spec

**Status:** proposed implementation spec  
**Date:** 2026-07-10  
**Supports:** [ADR-024](../adr/024-run-lanes-and-run-family-model.md), [ADR-042](../adr/042-slot-tracking-branches.md), [ROADMAP-next](../ROADMAP-next.md)

## Summary

Rename the branch-maintenance follow-up flow from `merge-main` to `update-branch`
and make the branch update strategy explicit. The product intent is not "make a
merge commit from main"; it is "update this PR branch against its base branch,
then continue CI/finalization."

Because this surface is still in development, do not create a long-lived public
dual-name period. This planning spec may mention the transition; operator-facing
UI, public docs, worker templates, and new run records should use
`update-branch` only after the implementation lands. Existing ADRs and public
docs should be updated in the implementation PR, not ahead of the code change.

## Backlog Item

**Title:** Rename branch-maintenance flow to `update-branch` and prefer rebase  
**Type:** product/platform cleanup  
**Priority:** high, before broader WorkGraph branch-maintenance automation  
**Area:** protocol, gateway, Command Center, worker templates, docs

## Acceptance Criteria

- Flow selection, run lists, CI-watch decisions, WorkGraph dispatch text, family
  observability, and retrospectives show `update-branch`, not the previous name.
- New branch-maintenance runs persist as `flowType: "update-branch"`.
- Existing local records written before the rename are migrated or normalized at
  load time so the UI does not expose the previous name.
- The flow has an explicit strategy: `rebase`, `merge`, or `project-default`.
- Default strategy prefers `rebase` for agent-owned PR branches when project
  policy allows it; any rebase push uses `--force-with-lease`.
- `merge` remains available for projects that disallow force-push, shared
  branches, or conflict cases where merge commits are explicitly safer.
- Chained runs resolve the real PR number/ref from family context or GitHub
  metadata; they never infer PR identity from manual ticket suffixes such as
  `MANUAL-000002`.
- Public/user docs describe only `update-branch`; ADRs may document the rename
  history.

## Current Code Surface

Start with these files; expand only where the compiler/tests force it:

- `packages/protocol/src/contracts/runs.ts` — `FlowType`, default artifacts, and
  flow metadata.
- `packages/protocol/src/contracts/work-graph.ts` — `rebase-onto` flow target.
- `packages/agent-runtime/scripts/mark-checklist-step.cjs` and
  `packages/agent-runtime/scripts/worker-terminal-contract.cjs` — required
  outcome artifacts.
- `services/gateway/src/ci-monitor/service.ts` and
  `services/gateway/src/run-engine/dispatch-policy.ts` — merge-conflict
  follow-up action mapping.
- `services/gateway/src/run-engine/ci-watch-chain.ts`,
  `services/gateway/src/run-engine/decision-replay.ts`, and
  `services/gateway/src/run-engine/recovery.ts` — chained-run and recovery
  behavior.
- `services/gateway/src/family-observability/*` and
  `services/gateway/src/run-completion/retrospective.ts` — family summaries and
  retrospectives.
- `apps/command-center/ui/src/components/**` — filters, flow graph, run actions,
  family metrics, and WorkGraph mock data.
- `scripts/docs/template-variable-catalog.mjs` and public docs under
  `apps/docs/docs/reference/` — generated/user docs after the implementation
  rename.

## Product Boundaries

- `update-branch` is a follow-up family member under ADR-024, like
  `pr-complete`: same `familyId`, parent/root linkage, inherited context, and
  isolated run artifacts.
- Strategy is a policy value, not encoded in the flow name.
- WorkGraph `rebase-onto` blockers should dispatch `update-branch` once wired.
- This work should remove confusing public language instead of adding deprecation
  warnings or aliases that operators see.

## Implementation Slices

### 1. Protocol and persistence

- Add `update-branch` to `FlowType` and generated flow metadata.
- Remove the previous branch-maintenance flow from the public protocol surface
  after adding load-time normalization for local history.
- Normalize existing local persisted runs/actions from the previous name to
  `update-branch` at load/migration boundaries.
- Update artifact contract defaults to `artifacts/report.md` (matches the
  worker terminal contract and the update-branch template output).
- Rename WorkGraph `rebase-onto` flow targets to `update-branch`.

### 2. Gateway dispatch and CI-watch

- Rename CI-watch merge-conflict action ids and labels to update-branch.
- Ensure auto-dispatch for merge conflicts creates `flowType: "update-branch"`.
- Update decision replay and recovery so pre-existing decisions normalize to the
  new action without rendering the old label.
- Thread branch-update strategy through prepare/task inputs without overloading
  the flow name.
- Keep prepare-time review integration separate: `review-pr` reviews the branch
  as pushed unless the operator explicitly asks for disposable integration.

### 3. Worker templates and artifact checks

- Rename project worker template files to `update-branch.md`.
- Update task copy to say "update branch" and require the selected strategy to
  be recorded in the outcome artifact.
- Require validation notes, conflict resolution summary, push command used, and
  risk notes in the outcome artifact.

### 4. Command Center

- Update flow filters, labels, graph text, run pipeline model, action buttons,
  retrospectives, and family metrics to `update-branch`.
- Do not render the previous name for migrated/normalized history.
- Show strategy where it matters: decision copy, run detail metadata, and worker
  task summary.

### 5. Documentation to update with the implementation PR

Do not pre-apply these changes in the planning PR. Once the code rename lands in
the implementation PR, update the documentation in the same PR so docs and
runtime behavior agree:

- Add ADR transition addenda to `docs/adr/024-run-lanes-and-run-family-model.md`
  and `docs/adr/042-slot-tracking-branches.md`.
- Update related ADR references that currently list follow-up flows or
  WorkGraph branch-maintenance flows, including ADR-017, ADR-030, ADR-040, and
  ADR-045.
- Update public/user docs under `apps/docs/docs/` to expose only
  `update-branch`; do not teach users the previous name.
- Update generated-doc sources, then regenerate checked-in generated docs.
- Update `docs/reference/adr-implementation-status.md` after the implementation
  and tests are complete.
- Replace this roadmap/spec pointer with shipped-history wording only after the
  implementation PR merges.

## Validation Plan

- Unit tests for flow normalization, CI-watch action mapping, WorkGraph
  `rebase-onto` dispatch, and PR identity resolution from family/GitHub metadata.
- Artifact-contract tests for `update-branch` outcome files.
- Command Center typecheck and focused UI tests for flow labels/filters.
- Live E2E proof on a real PR branch:
  1. create or select a PR branch behind base;
  2. dispatch `update-branch`;
  3. verify strategy selection, worker task copy, outcome artifact, and push;
  4. verify CI-watch/family UI shows `update-branch`;
  5. verify no public/operator UI shows the previous name.

## Non-Goals

- Changing `pr-complete` semantics.
- Forcing rebase for every project or protected/shared branch.
- Introducing a permanent public compatibility alias.
- Solving all WorkGraph scheduling automation in this PR.
