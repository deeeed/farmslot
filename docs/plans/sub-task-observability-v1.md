# Sub-Task Observability v1 Implementation Spec

**Status:** proposed implementation spec
**Date:** 2026-09-19
**Supports:** [ADR-060](../adr/060-sub-task-observability.md), [ROADMAP-next](../ROADMAP-next.md) lane "Worker phase decomposition and sub-agent cost roll-up", [Task directory contract](../reference/task-directory-contract.md)

## Summary

A checklist step can own a child unit: a separate checklist plus signal under `subtasks/`, written only by `mark`, observed by the gateway, rendered under the parent step by every client. Farmslot never spawns the child; it materializes files and reads signals. A second primitive turns acceptance criteria into a verdict ledger with evidence.

Ship order: child units first (Phases 1 to 4), AC ledger second (Phase 5). Each phase has its own PR and proof.

## Backlog item

**Title:** Sub-task observability: child checklist units and acceptance-criteria ledger
**Type:** framework contract + producer tooling + observability surfaces
**Priority:** high, before farm templates move review steps onto team skills
**Area:** protocol, agent-runtime, gateway, Command Center, Companion, harness templates

## Layout

```text
<task>/
  CHECKLIST.md                          parent, unchanged, flat
  SIGNAL.json                           parent, unchanged
  subtasks/
    index.json                          mark-maintained registry of child units
    <id>.md                             child checklist (materialized source, placeholders rendered)
    <id>-SIGNAL.json                    child signal (WorkerSignal + parent link)
  artifacts/
    acceptance-status.json              Phase 5: AC ledger, written by `farmslot-agent ac` only
```

`<id>` is a slug (`[a-z0-9-]+`), unique per task directory. `<id>-SIGNAL.json` follows the existing `signalFileForChecklist` derivation, so no new naming rule is introduced.

### `subtasks/index.json`

```json
{
  "schemaVersion": 1,
  "units": [
    {
      "id": "perps-review",
      "parent": { "checklist": "CHECKLIST.md", "stepNumber": 21 },
      "checklist": "subtasks/perps-review.md",
      "signal": "subtasks/perps-review-SIGNAL.json",
      "source": {
        "kind": "skill",
        "ref": ".agents/skills/mms-perps-review-pr/skill.md",
        "sha256": "<source digest>",
        "renderedSha256": "<child checklist digest>"
      },
      "registeredAt": "2026-09-19T10:00:00Z"
    }
  ]
}
```

`source.kind` is `skill`, `template` (catalog id), or `inline` (text passed on the command line, digest only). The index is the one file the gateway watches to discover children; it never holds progress.

### Child signal

`WorkerSignal` plus:

```ts
interface WorkerSignalParentLink {
  checklist: string; // parent checklist basename
  stepNumber: number; // 1-based parent step
  attemptId?: string; // parent attemptId at registration
}
```

`role` is `subtask`; `contextId` is the child id. `checklistTiming.source` is the child checklist path. Everything else (status, outcome, reason, timestamps) is unchanged so the existing normalizer, probe, and staleness code apply.

## Worker verbs

All verbs live in the agent-runtime mark engine (`scripts/mark-checklist-step.cjs`) with the shared logic in `@farmslot/protocol/checklist-target` and its CJS mirror, so the gateway parser and the harness enumerate the same rows.

```
./mark sub start <id> --step N --from <path|template:<id>> [--var k=v ...]
./mark sub <id> <n>
./mark sub <id> complete [--report <artifact>] [--mark-last]
./mark sub <id> blocked --reason "..."
./mark sub <id> status            # prints the child projection as JSON
```

Rules enforced by `mark`:

| Situation                                                | Behaviour                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `sub start` on a step already owning a running child     | refuse: `step N already owned by subtask <id>`                                                                |
| `sub start` on a checked step                            | refuse                                                                                                        |
| `mark N` while a child owns step N and is not terminal   | refuse with pointer: `step N is owned by subtask <id>; finish it with ./mark sub <id> complete`               |
| child `complete`                                         | writes child terminal signal, ticks parent box N, appends parent `checklistTiming` event labelled from step N |
| `mark N` after child completed                           | no-op, exit 0 (box already checked)                                                                           |
| child `blocked`                                          | child signal `blocked`; parent signal `blocked` with `reason: "subtask <id>: <reason>"`                       |
| parent terminal (`complete --mark-last`) with open child | refuse: every child must be terminal                                                                          |
| `--from` source has no enumerable checkbox               | refuse: a child unit must have at least one step                                                              |
| `--from` source fails `checklistNumberingMismatches`     | refuse, print mismatches                                                                                      |

The refusals are the answer to "auto-tick could confuse the agent": the agent cannot mark the parent while the child runs, and the template text says the step is done by finishing the child. A second `mark N` costs nothing.

Materialization reuses the execution-template renderer: placeholders (`{{TASK_DIR}}`, `{{REPO}}`, project vars) are expanded; `CHECKLIST_SKIP_SECTIONS` applies, so a skill's "Rules" or "Description" section is not counted. The source digest is recorded before rendering, the rendered digest after, mirroring `executionTemplate.sha256` and `renderedSha256`.

## Gateway

- **Watch.** `tasks/watcher.ts` adds a watch on `subtasks/index.json`; on change it (re)watches each listed child checklist and signal, local via chokidar and remote via the node `fs.watch` request the parent already uses.
- **Project.** `TaskStepProgress` gains:

  ```ts
  subtask?: {
    id: string;
    status: WorkerSignalStatus | 'stale';
    source: { kind: 'skill' | 'template' | 'inline'; ref?: string; sha256: string };
    progress: TaskProgressStructured; // recursive
    lastEventAt: string | null;
  };
  ```

  `taskProgress` builds it from the child checklist and signal through the same parser as the parent. Depth is capped at 1 in v1 by the mark engine, not the schema.

- **Accept.** `shouldAcceptTaskProgressUpdate` treats `role: 'subtask'` updates as belonging to the active parent checklist; a child of a role checklist (`SELF-REVIEW.md`) is accepted while that role is active.
- **Staleness.** A running child with no mark event for the run's configured idle window projects `stale`. No process or pane inspection.
- **Copy and mirror.** `subtasks/` joins the dispatch copy list, the re-sync list, and the completion mirror (`subtasks/*.worker` beside the orchestrator copy). `isGatewayOwnedArtifactMirrorEntry` is unchanged: child files are worker-owned.
- **Terminal contract.** `mark complete --mark-last` on the parent requires every registered child terminal; the artifact contract check reports open children as a failure.
- **Metrics.** `deriveChecklistStepDurations` runs per child; `session-metrics.json` gains `subtasks[]` with per-unit duration and step count. Nothing else in the cost lane changes.

## Clients

- **Command Center.** Run detail progress renders a nested block under the owning step: child title (source ref), status pill, `completed/total`, current step, collapsible child steps. Family observability per-step durations include child units. Proof: CDP screenshot with a live child at mid-progress and after completion.
- **Companion.** Same projection, same nesting, read-only.
- **Harness `status --watch`.** Uses the shared protocol projection; prints the child rows indented under the parent step. No harness-side parsing.

## Farm templates

Two edits, both in the metamask farm repo, both after Phase 3 lands on every node:

- `dev.md` step 21 becomes: register `perps-review` from the installed review skill with `--step 21`, follow the child checklist, finish it with `sub complete --report artifacts/review.md`. The bullet list of what to check moves out of the farm template; the skill owns it.
- `review-pr.static-perps.md` box 1 becomes the same registration against the frozen target; box 2 is unchanged.

The skill library needs no change. A skill whose body is not checklist-shaped cannot be a child unit; that is a skill authoring constraint, recorded in the skills package guidance.

## Phase 5: acceptance-criteria ledger

Recommended model: one JSON ledger, one writer, markdown rendered from it. It is the simplest that is parseable, contract-checkable, and keeps the "only `X` writes `Y`" rule the signal already follows.

- Task init emits `inputs/acceptance-criteria.json`: `[{ id: "AC-1", text }]` from the `acceptanceCriteria` it already renders into `TASK.md`. Ids are positional and stable for the task directory.
- `farmslot-agent ac set <id> <verdict> [--evidence path ...] [--recipe-node id ...] [--note "..."]` writes `artifacts/acceptance-status.json`:

  ```json
  {
    "schemaVersion": 1,
    "criteria": [
      {
        "id": "AC-1",
        "text": "...",
        "verdict": "proven",
        "proofMode": "visual",
        "evidence": ["artifacts/after-order-sheet.png"],
        "recipeNodes": ["assert-order-sheet"],
        "note": "",
        "updatedAt": "..."
      }
    ]
  }
  ```

  Verdicts: `proven`, `weak`, `missing`, `untestable`. `proofMode`: `state`, `visual`, `mixed`.

- `farmslot-agent ac render` prints the coverage table that `recipe-coverage.md` holds today, ending with the same `Overall recipe coverage:` line. The PR-body renderer reads the ledger; farm templates stop asking the worker to hand-write `recipe-coverage.md` once the ledger ships.
- Terminal contract: `complete` requires a verdict for every id in `inputs/acceptance-criteria.json`; `missing` or `weak` fails `check-task-artifact-contract.mjs` unless the flow's contract waives it.
- Gateway watches the ledger; run detail shows an AC panel (id, verdict, evidence links). Family observability counts `proven / total`.

Alternative considered: keep `recipe-coverage.md` as the source and parse it. Rejected: two formats to keep aligned, prose tables drift, and a parser on worker-written markdown is the class of fragility the checklist contract avoids.

## Layering

| Layer                       | Adds                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`        | `WorkerSignalParentLink`, `role: 'subtask'`, `TaskStepProgress.subtask`, `SubtaskIndex`, `AcceptanceStatusLedger`, `SUBTASKS_DIR`, child path derivation   |
| `@farmslot/agent-runtime`   | `mark sub` verbs + CJS mirror, source materializer (reuses execution-template render + digest), `ac` verbs, contract-check extensions, `task init` AC file |
| `services/gateway`          | watcher, projection, acceptance rule, copy/mirror lists, terminal check, metrics                                                                           |
| Command Center + Companion  | nested progress block, AC panel                                                                                                                            |
| `@farmslot/skills` guidance | "checklist-shaped skill" authoring rule                                                                                                                    |
| mm-harness (separate repo)  | `status --watch` rendering through the shared projection; template edits in the farm repo                                                                  |
| Farm packs                  | which skill each step registers; no logic                                                                                                                  |

Farmslot owns abstractions and the producer; the harness wraps; packs hold values.

## Phases and proof

Each phase is one PR. Unit tests are regression guards; proof is the live scenario named per phase, run through the production gateway on the operator checkout, with the recipe extended for every review-round change.

| Phase | Scope                                                                                       | Proof                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | protocol types; mark `sub` verbs + CJS mirror; materializer; refusal table                  | scripted-runner scenario: register child from a checklist-shaped fixture skill, mark child steps, `mark N` refused mid-child, child `complete` ticks parent, parent `complete --mark-last` refused with open child |
| 2     | gateway watch + projection + copy/mirror + terminal check                                   | `cdp.mjs gateway task.progress` shows `subtask` under the step on a live slot; `*.worker` mirror contains `subtasks/`; stale projection after idle window                                                          |
| 3     | Command Center + Companion rendering; harness `status --watch`                              | CDP screenshots mid-child and after completion; harness watch output on the same run                                                                                                                               |
| 4     | farm template edits (`dev.md` 21, `review-pr.static-perps.md` 1); skills authoring guidance | one real dev run and one static review run on a slot with the child visible end to end; family retrospective shows child durations                                                                                 |
| 5     | AC ledger: task init file, `ac` verbs, renderer, contract check, gateway panel              | dev run where every AC gets a verdict, one deliberately `missing` blocks `complete`, panel renders verdicts and evidence links                                                                                     |

Node rollout: Phases 1 and 2 change the mark engine and the node fs.watch contract; deploy both node instances and the harness before Phase 4 templates reference `mark sub`.

## Acceptance criteria

- A step can register one child unit from a skill file, a catalog template id, or inline text; the child checklist enumerates through the same parser as the parent, with provenance digests.
- `mark` refuses parent marks on a step owned by a running child, ticks the parent on child completion, and treats a later parent mark of that step as a no-op.
- Child `blocked` surfaces as parent `blocked` with the child reason; parent terminal marks refuse while any child is open.
- Gateway `task.progress` returns a recursive child projection with status, source, counts, current step, and last event time, for local and remote slots.
- Command Center, Companion, and harness `status --watch` render the child under its step from the one projection.
- `subtasks/` travels to the slot on dispatch and re-sync and mirrors back on completion.
- Per-child step durations appear in session metrics and family observability.
- Farmslot spawns nothing: no tmux, process, or session code is added by this work.
- Acceptance criteria get ids at task init, verdicts through `farmslot-agent ac`, a rendered coverage table, a terminal-contract check, and a run-detail panel.

## Open questions

- Should a child unit be allowed on a role checklist (`SELF-REVIEW.md`) in v1, or only on `CHECKLIST.md`? Default: allowed, same rules, since the reviewer role is the first place a team skill runs.
- Idle window for `stale`: reuse the run's existing worker idle threshold or a separate child threshold? Default: reuse.
- `ac` verbs as part of `mark` (`./mark ac ...`) or a separate `farmslot-agent ac` entry point? Default: separate, since the ledger is not a checklist and `mark` should stay the one signal writer.
