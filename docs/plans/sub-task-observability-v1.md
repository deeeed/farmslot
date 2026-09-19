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

`<id>` is a slug (`[a-z0-9-]+`), unique per task directory. The signal basename derivation matches `signalFileForChecklist` (strip `.md`, append `-SIGNAL.json`); the `subtasks/` prefix is new and needs a child-path helper in `@farmslot/protocol` (`subtaskPaths(id)` returning both relative paths).

Child units are not role switches. They never write `checklist-target.json`, never change the run's active task file, and are not driven by the gateway role-switch mechanism. A child may hang off `CHECKLIST.md` or off a role checklist such as `SELF-REVIEW.md`; either way the parent link names the file.

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

The on-disk file is a `WorkerSignal` with one added top-level field, `parent`:

```ts
interface WorkerSignalParentLink {
  checklist: string; // parent checklist basename, e.g. "CHECKLIST.md"
  stepNumber: number; // 1-based parent step
}

interface SubtaskSignal extends WorkerSignal {
  role: 'subtask';
  contextId: string; // the child id
  parent: WorkerSignalParentLink;
}
```

`sub start` writes this initial payload:

```json
{
  "role": "subtask",
  "contextId": "perps-review",
  "attemptId": "<parent attemptId at registration>",
  "parent": { "checklist": "CHECKLIST.md", "stepNumber": 21 },
  "status": "running",
  "checklistTiming": { "schemaVersion": 1, "source": "subtasks/perps-review.md", "events": [] },
  "timestamp": "2026-09-19T10:00:00Z"
}
```

The child shares the parent's `attemptId` at registration so every signal of one attempt correlates; `contextId` tells them apart. Everything else (status, outcome, reason, step, timestamps) keeps parent semantics so the existing normalizer and probe apply. `stale` never appears in the file; it is a gateway projection (see Gateway).

### Protocol type changes

- `AGENT_ROLES` gains `'subtask'`. `NestedLoopAgentRole` is an `Extract` over the union and does not change, so `CHECKLIST_TARGET_BY_AGENT_ROLE`, `checklistTargetForAgentRole`, and `agentRoleForChecklistBasename` have no `subtask` entry by design. Audit `nestedLoopProgressLabel`, the Command Center and Companion role label maps, and `AgentContext` role consumers for exhaustive switches.
- `WorkerSignal` gains optional `parent?: WorkerSignalParentLink`; `SubtaskSignal` narrows it.
- `TaskProgressStructured` / `TaskStepProgress` gain the child projection (see Gateway).
- `SubtaskIndex`, `SubtaskIndexUnit`, `SUBTASKS_DIR`, `subtaskPaths(id)`, `isSettledSubtaskStatus(status)`.
- `TaskProgressAcceptanceUpdate` and `TaskProgressUpdatedPayload` gain `parentChecklist` (see Gateway, Accept).

## Worker verbs

All verbs live in the agent-runtime mark engine (`scripts/mark-checklist-step.cjs`) with the shared logic in `@farmslot/protocol/checklist-target` and its CJS mirror, so the gateway parser and the harness enumerate the same rows.

```
./mark sub start <id> --step N --from <path|inline:<text>> [--var k=v ...]
./mark sub <id> <n>
./mark sub <id> complete [--report <artifact>] [--mark-last]
./mark sub <id> blocked --reason "..."
./mark sub <id> status            # prints the child projection as JSON
```

`template:<id>` catalog resolution is refused in v1 (recorded in the agent-runtime changelog); register skills by installed path.

Rules enforced by `mark`:

| Situation                                                  | Behaviour                                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sub start` on a step that already has a child, any status | refuse: `step N already owned by subtask <id>`; one child per step for the life of the task directory                                                 |
| `sub start` on a checked step                              | refuse                                                                                                                                                |
| `--from` source has no enumerable checkbox                 | refuse: a child unit must have at least one step                                                                                                      |
| `--from` source fails `checklistNumberingMismatches`       | refuse, print mismatches                                                                                                                              |
| `mark N` while a child owns step N and is not settled      | refuse with pointer: `step N is owned by subtask <id>; finish it with ./mark sub <id> complete`                                                       |
| `sub <id> <n>`                                             | ticks child box n, appends a child `checklistTiming` event, child status `running` (also after `blocked`, see recovery)                               |
| `sub <id> complete`                                        | asserts child boxes (see `--mark-last`), asserts `--report` if given, writes child terminal signal, ticks parent box N, appends a parent timing event |
| `sub <id> complete --mark-last`                            | parent semantics: every child box must be `[x]` except at most the last, which it ticks                                                               |
| `sub <id> complete` without `--mark-last`                  | every child box must already be `[x]`                                                                                                                 |
| `mark N` after child completed                             | no-op, exit 0 (box already checked)                                                                                                                   |
| `sub <id> blocked`                                         | child signal `blocked`; parent signal `blocked` with `reason: "subtask <id>: <reason>"` and `step` = parent step N label                              |
| parent terminal (`complete --mark-last`) with open child   | refuse: every child must be settled                                                                                                                   |

**Settled versus open.** A child is settled when its status is `complete` or `done`; it is open while `running` or `blocked`. There is no `sub failed` verb: a child that cannot finish reports `blocked` with a reason, and a child signal file never carries `failed`. The helper lives in `transport/signal.ts` beside `isTerminalWorkerSignalStatus`. `blocked` counts as terminal for `isTerminalWorkerSignalStatus`, so the run stops, but it keeps step ownership: the parent cannot mark past a child that has not finished. `mark` and the gateway use one protocol helper, `isSettledSubtaskStatus`, for every ownership and parent-terminal check, never the bare terminal predicate.

**Parent timing event on child completion.** The appended parent event is `{ stepNumber: N, label: checklistStepName(parentRow.rawLabel), checkedAt }`, identical to a normal parent mark, so `deriveChecklistStepDurations` needs no change.

**Child terminal contract.** Child units have no terminal contract. `sub complete` never consults `terminalContractInputForChecklist`, `inputs/worker-terminal-contract.json`, or `inferFlowType`, and never runs `check-task-artifact-contract.mjs`. Its only artifact rule is `--report <path>`: when given, the file must exist and be non-empty. The parent's terminal contract still governs the parent's own `complete`, which is where a report such as `artifacts/review.md` is required by the flow.

**Recovery after `blocked`.** A child `blocked` makes the run `blocked` through the parent signal, exactly as a parent `mark blocked` does today; the operator uses the existing blocked-run actions (fix feedback, relaunch). When work resumes, the next `sub <id> <n>` or `sub <id> complete` flips the child back to `running`/terminal and rewrites the parent signal to `running` with the parent step, mirroring how a parent `mark N` after `blocked` already writes `running`. There is no replacement child: one id per step.

The refusals are the answer to "auto-tick could confuse the agent": the agent cannot mark the parent while the child runs, and the template text says the step is done by finishing the child. A second `mark N` costs nothing.

Materialization reuses the execution-template renderer: placeholders (`{{TASK_DIR}}`, `{{REPO}}`, project vars) are expanded; `CHECKLIST_SKIP_SECTIONS` applies, so a skill's "Rules" or "Description" section is not counted. The source digest is recorded before rendering, the rendered digest after, mirroring `executionTemplate.sha256` and `renderedSha256`.

## Gateway

- **Watch.** `tasks/watcher.ts` adds a watch on `subtasks/index.json`; on change it (re)watches each listed child checklist and signal, local via chokidar and remote via the node `fs.watch` request the parent already uses.
- **Project.** `TaskStepProgress` gains:

  ```ts
  subtask?: {
    id: string;
    status: WorkerSignalStatus | 'stale';
    source: { kind: 'skill' | 'template' | 'inline'; ref?: string; sha256: string; renderedSha256: string };
    progress: TaskProgressStructured; // recursive
    lastEventAt: string | null;
  };
  ```

  `taskProgress` builds the child schema with `generateTaskSchema(childMarkdown, run.flowType)`; the flow type only labels the schema, enumeration is flow-independent. `'stale'` is projected when the child file says `running` and no mark event landed within the run's existing worker idle threshold (no separate child threshold). Depth is capped at 1 in v1 by the mark engine, not the schema.

- **Accept.** `shouldAcceptTaskProgressUpdate` today accepts a nested-loop update only when `contextId` equals the role derived from the active task file, so a child update (`contextId: 'perps-review'`, `role: 'subtask'`) would be dropped whenever a role checklist is active. New rule, in the same protocol module with tests: a `subtask` update is accepted when `update.parentChecklist` equals the active task file basename (the worker file when no role checklist is active). A child parented on a checklist that is no longer active is not live: its parent step was settled when that checklist reached its terminal mark, so its updates are dropped like any other off-role update. Test matrix:

  | child parent     | active task file | accept |
  | ---------------- | ---------------- | ------ |
  | `CHECKLIST.md`   | worker file      | yes    |
  | `SELF-REVIEW.md` | `SELF-REVIEW.md` | yes    |
  | `CHECKLIST.md`   | `SELF-REVIEW.md` | no     |
  | `SELF-REVIEW.md` | worker file      | no     |

  "Worker file" means `activeTaskFile === run.taskFile`, the branch where today's helper already accepts everything; the prose predicate is the source of truth. `TaskProgressUpdatedPayload` in `transport/events.ts` gains `parentChecklist?: string` so the gateway broadcast carries it. The Command Center wrapper in `run-detail-model.ts` widens its `Pick` to include it. Companion replaces its own `SELF-REVIEW.md` string filter in `lib/task-progress.ts` with the protocol helper.

- **Copy and mirror.** Dispatch, re-sync, and warm handoff copy `subtasks/` as a directory beside `inputs/` and `artifacts/`, not through `TASK_ROOT_SIDECARS`. At completion, each file under `subtasks/` (checklists, signals, and the index) is mirrored back beside the orchestrator copy as `subtasks/<name>.worker` from a directory listing rather than a fixed name list, following the `TASK.md.worker` / `CHECKLIST.md.worker` pattern in `run-completion/artifact-mirror.ts`. `isGatewayOwnedArtifactMirrorEntry` is unchanged: child files are worker-owned.
- **Terminal contract.** `mark complete --mark-last` on the parent requires every registered child settled; the artifact contract check reports open children as a failure.
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

One JSON ledger, one writer, markdown rendered from it. Parseable, contract-checkable, and it keeps the "only `X` writes `Y`" rule the signal already follows. Like `SIGNAL.json`, the ledger is a framework-written artifact invoked by the worker, not direct worker output.

- No new inputs file (direction of backlog item MANUAL-000092: no third AC surface). Task init already receives the criteria as an input array but persists them only as `TASK.md` prose today; Phase 5 adds `task.acceptanceCriteria: string[]` to `HandoffMetadata` so `inputs/handoff.json` carries them. Ids are `AC-<N>`, N the 1-based position in that array; task init is the sole id producer. `TASK.md` keeps rendering the same list as prose for the worker to read.
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

  Verdicts: `proven`, `weak`, `missing`, `untestable`. `proofMode`: `state`, `visual`, `mixed`. `ac` is a separate agent-runtime entry point, not a `mark` verb: the ledger is not a checklist and `mark` stays the one signal writer.

- `farmslot-agent ac render` prints the coverage table that `recipe-coverage.md` holds today, ending with the same `Overall recipe coverage:` line. The PR-body renderer reads the ledger; farm templates stop asking the worker to hand-write `recipe-coverage.md` once the ledger ships.
- Terminal contract: `complete` requires a verdict for every id; `missing` or `weak` fails `check-task-artifact-contract.mjs` unless the flow's contract waives it.
- Gateway watches the ledger; run detail shows an AC panel (id, verdict, evidence links). Family observability counts `proven / total`.

Alternative considered: keep `recipe-coverage.md` as the source and parse it. Rejected: two formats to keep aligned, prose tables drift, and a parser on worker-written markdown is the class of fragility the checklist contract avoids.

## Layering

| Layer                       | Adds                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`        | `'subtask'` in `AGENT_ROLES`, `WorkerSignalParentLink`, `SubtaskSignal`, `TaskStepProgress.subtask`, `SubtaskIndex`, `SUBTASKS_DIR`, `subtaskPaths`, acceptance-rule extension, `AcceptanceStatusLedger` |
| `@farmslot/agent-runtime`   | `mark sub` verbs + CJS mirror, source materializer (reuses execution-template render + digest), `ac` entry point, contract-check extensions, handoff AC array                                            |
| `services/gateway`          | watcher, projection, acceptance rule, directory copy + per-file mirror, terminal check, metrics                                                                                                          |
| Command Center + Companion  | nested progress block, AC panel, acceptance-rule mirrors                                                                                                                                                 |
| `@farmslot/skills` guidance | "checklist-shaped skill" authoring rule                                                                                                                                                                  |
| mm-harness (separate repo)  | `status --watch` rendering through the shared projection; template edits in the farm repo                                                                                                                |
| Farm packs                  | which skill each step registers; no logic                                                                                                                                                                |

Farmslot owns abstractions and the producer; the harness wraps; packs hold values.

## Phases and proof

Each phase is one PR. Unit tests are regression guards; proof is the live scenario named per phase, run through the production gateway on the operator checkout, with the recipe extended for every review-round change.

| Phase | Scope                                                                                                                                                      | Proof                                                                                                                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | protocol types; mark `sub` verbs + CJS mirror; materializer; refusal table                                                                                 | scripted-runner scenario: register child from a checklist-shaped fixture skill, mark child steps, `mark N` refused mid-child, child `complete` ticks parent with the parent timing event, `blocked` then resume flips both signals, parent `complete --mark-last` refused with open child |
| 2     | gateway watch + projection + acceptance rule + copy/mirror + terminal check; task-directory contract rows for `subtasks/` (layout, travel, mirror, layers) | `cdp.mjs gateway task.progress` shows `subtask` under the step on a live slot, including a child registered on `SELF-REVIEW.md` during an active self-review round; `subtasks/<name>.worker` files exist after completion; stale projection after the idle window                         |
| 3     | Command Center + Companion rendering; harness `status --watch`                                                                                             | CDP screenshots mid-child and after completion; harness watch output on the same run                                                                                                                                                                                                      |
| 4     | farm template edits (`dev.md` 21, `review-pr.static-perps.md` 1); skills authoring guidance                                                                | one real dev run and one static review run on a slot with the child visible end to end; family retrospective shows child durations                                                                                                                                                        |
| 5     | AC ledger: handoff AC array, `ac` entry point, renderer, contract check, gateway panel                                                                     | dev run where every AC gets a verdict, one deliberately `missing` blocks `complete`, panel renders verdicts and evidence links                                                                                                                                                            |

Node rollout: Phases 1 and 2 change the mark engine and the node fs.watch contract; deploy both node instances and the harness before Phase 4 templates reference `mark sub`.

## Acceptance criteria

- A step can register one child unit from a skill file, a catalog template id, or inline text; the child checklist enumerates through the same parser as the parent, with provenance digests.
- `mark` refuses parent marks on a step owned by a running child, ticks the parent on child completion with a normal parent timing event, and treats a later parent mark of that step as a no-op.
- Child `complete` has no flow terminal contract; `--report` is its only artifact rule.
- Child `blocked` surfaces as parent `blocked` with the child reason; resuming the child restores `running` on both; parent terminal marks refuse while any child is open.
- Gateway `task.progress` returns a recursive child projection with status (including projected `stale`), source digests, counts, current step, and last event time, for local and remote slots, and accepts child updates whose parent checklist is the active task file.
- Command Center, Companion, and harness `status --watch` render the child under its step from the one projection.
- `subtasks/` travels to the slot on dispatch and re-sync as a directory and mirrors back per file as `.worker` on completion.
- Per-child step durations appear in session metrics and family observability.
- Farmslot spawns nothing: no tmux, process, or session code is added by this work.
- Acceptance criteria get `AC-<N>` ids from the handoff array, verdicts through `farmslot-agent ac`, a rendered coverage table, a terminal-contract check, and a run-detail panel.

## Open questions

- Should Phase 4 also move the `SELF-REVIEW.md` role template's domain-pattern step onto a child unit, or keep that for a later template pass? Default: later pass, after one real run proves the mechanism on `CHECKLIST.md`.
