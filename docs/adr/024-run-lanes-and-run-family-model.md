# ADR-024: Run Lanes and Run-Family Model

**Status:** Accepted  
**Date:** 2026-04-13  
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-018](018-dev-flow-interactive-autonomous.md), [ADR-022](022-slot-lifecycle-simplification.md), [ADR-023](023-runner-agnostic-tui-execution.md)

## Context

Farmslot now has enough orchestration features that three distinct kinds of work are being forced through one run model:

1. **Production work** — the canonical run for a ticket or PR, where blocking decisions and human gates are desirable.
2. **Validation work** — proving a flow or runner works end-to-end, where repeated manual gate babysitting is wasteful.
3. **Comparison work** — intentionally running the same ticket/PR multiple times (for example Claude vs Codex, or two alternative fixes) and comparing artifacts.

The current system partially supports each of these, but not as a unified model:

- `run.create` currently rejects duplicate active runs for the same `ticketOrPr` + `project`.
- `task-writer.ts` already creates timestamped task directories, which is useful for comparisons, but collisions are still surfaced as decisions.
- `review-pr`, `pr-complete`, `merge-main`, self-review, and CI-fix already form a de facto family of follow-up runs, but that relationship is not documented as a first-class model.
- Validation mode now exists and can auto-resolve routine decisions, but the product/docs do not yet define how it differs from production runs or how it relates to comparison runs.
- Slot contamination was observed in practice when multiple related runs reused the same slot/pane without an explicit run-family contract.

This makes similar/comparison runs feel ad hoc, and it makes the relationship between `fix-bug`, `review-pr`, `pr-complete`, `merge-main`, self-review, and CI-fix harder to reason about than it should be.

Current documentation and implementation already imply part of the model, but only in fragments:

- `task-writer.ts` documents that each run gets a timestamped task directory and explicitly notes that this _allows comparison across runs_.
- Current task layout conventions use flow-first task directories (`tasks/<flow>/<ticket-slug>-<timestamp>/`) and collision decisions captured by the run-family model.
- `docs/reference/fine-tuning.md` documents repeated runs of the same ticket as separate timestamped task folders, which is effectively comparison-oriented behavior.
- Earlier `pr-complete` pass archiving under a parent task was an early form of run-family grouping.

What is missing is a single product-level statement of:

- why the current flow-first layout exists,
- when duplicate/sibling runs are intentional,
- how related follow-up flows belong to one family, and
- what the _ideal_ steady-state model should be.

## Decision

Adopt an explicit **lane model** plus a **run-family identity model**.

### 0. Runtime classification taxonomy: one implementation axis per job

This section defines low-level run classification, not the whole user-facing eval product model. The cleaner product paradigm for evals is described in ADR-030 as: case → candidate strategy → trial → result package → experiment → suite.

Within runtime classification, the model must not reuse one word for several jobs:

| Concept                  | Answers                                    | Owns                                                                                                                           | Must not be used for                                  |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `flowType`               | “Which worker pipeline/template executes?” | Step sequence and task writer carrier: `dev`, `fix-bug`, `review-pr`, `pr-complete`, `merge-main`.                             | Product evaluation identity or candidate grouping.    |
| `mode`                   | “How interactive/autonomous is this run?”  | Operator/autonomy behavior such as `interactive`, `autonomous`, or the validation convenience preset.                          | Duplicating siblings or labeling eval candidates.     |
| `lane`                   | “What policy bucket is this run in?”       | Duplicate-run policy, slot isolation, side-effect posture: `production`, `validation`, `comparison`.                           | Flow selection or rubric semantics.                   |
| `variant`                | “Which sibling is this comparison trial?”  | Human-readable runtime identity inside one comparison family, e.g. `claude`, `codex`, `current-template`, `proposed-template`. | A mode, flow, or experiment ID.                       |
| `completionPolicy`       | “What may happen at completion?”           | Publication side effects: default publication behavior vs `artifact-only`.                                                     | Sibling identity or flow selection.                   |
| `taskProfile`            | “What does success mean?”                  | Eval/package rubric semantics such as `fix-bug` vs `dev`.                                                                      | Runtime pipeline selection.                           |
| `EvalExperimentManifest` | “What packages are being judged together?” | Experiment identity, case, candidate strategies, trials, rubric, and package comparison state.                                 | Replacing run lane/mode or creating a new `FlowType`. |

Classification invariants:

- `mode:'validation'` resolves to `lane:'validation'`; validation mode cannot be paired with comparison lane.
- `lane:'comparison'` requires a non-empty `variant`.
- Non-comparison lanes must not carry a `variant`.
- Sibling replay, model comparison, template regression, and old-vs-new package checks use `lane:'comparison' + variant`, not validation mode.
- Eval trials may use `flowType:'dev'` as an implementation carrier while the experiment package records `taskProfile`, `lane:'comparison'`, `variant`, and `completionPolicy:'artifact-only'`.

### 1. Every run belongs to a lane

Farmslot should treat runs as belonging to one of three lanes:

#### A. Production lane

The default lane for normal work.

Properties:

- one canonical active run per `project + ticketOrPr`
- human/review/CI decisions block normally
- duplicate active runs for the same ticket/PR are rejected
- branch names should be canonical and stable
- slot reuse is conservative

This lane optimizes for correctness, auditability, and predictable operator expectations.

#### B. Validation lane

The lane for proving orchestration or runner behavior.

Properties:

- uses real flows and task templates
- routine blocking decisions may auto-resolve
- slot preparation may be skipped when a warm, healthy slot is already aligned
- review/CI posting side effects may be suppressed or auto-dismissed
- duplicate runs are still discouraged unless explicitly needed

This lane optimizes for speed of validation while staying as close to production semantics as practical.

#### C. Comparison lane

The lane for intentionally running multiple variants of the same work.

Properties:

- duplicate runs for the same `project + ticketOrPr` are allowed by design
- each run must declare a **variant label** (for example `claude`, `codex`, `candidate-a`)
- branch names and task paths must be variant-distinguishable
- result comparison is a first-class expected outcome
- slots for sibling runs should be isolated from each other

This lane optimizes for side-by-side evaluation, not for being the one canonical run.

### 2. Every run belongs to a run family

Introduce a product-level concept of a **run family**.

A run family groups related runs such as:

- the original `fix-bug` run for a ticket
- its chained `pr-complete` follow-up
- a later `merge-main` conflict-fix run
- sibling comparison runs like `claude` vs `codex`

At minimum, a run family should carry:

- `familyId` — stable identifier for the family
- `lane` — `production | validation | comparison`
- `familyRootTicketOrPr` — canonical ticket/PR reference
- `variant` — optional label for comparison siblings
- `parentRunId` — when this run is a follow-up of another run

This identity should be visible both in persisted run state and in slot state so contamination is detectable. Follow-up family runs inherit the parent run's `safetyTier` unless explicitly overridden at dispatch time, so a `full-auto` fix does not silently escalate to `dangerous` during `pr-complete` chaining.

Run families should also be treated as the source of truth for **inherited context**. A follow-up run should not behave like an isolated fresh task when a family root already exists. In particular, family members such as `review-pr`, `pr-complete`, and `merge-main` should be able to resolve and inherit earlier artifacts like:

- original task path / task dir
- original worker `report.md`
- original `learnings.md`
- original `recipe.json` and `recipe-coverage.md`
- original ticket/bug scope summary

This is important because follow-up work is often triggered by a narrow symptom (for example one reviewer comment or one CI failure), while the correct evaluation still depends on the broader intent of the original family-root task. Without family-context inheritance, follow-up runs can incorrectly optimize for the latest symptom and lose the real scope of the work.

Inherited context should prefer **artifact references over prompt stuffing**. The system should avoid copying large inherited blobs directly into the worker prompt when the same information can be resolved to files. The desired behavior is:

- resolve the best available source of inherited context
- materialize that context into the current task folder when needed
- pass the worker file references / paths, not full copied content

This keeps prompts compact, preserves provenance, and makes inherited context reusable across future family members.

### 3. Duplicate-run policy becomes lane-aware

#### Production lane

- reject duplicate active runs for the same `project + ticketOrPr`

#### Validation lane

- default to the production duplicate guard
- allow explicit overrides for certification cases when a fresh task dir or fresh slot is required

#### Comparison lane

- allow duplicate active runs for the same `project + ticketOrPr`
- require a variant label
- require task and branch naming to encode that variant

This keeps the strict safety of the production lane while giving comparison work an intentional, documented escape hatch.

### 4. Branch and task naming must optimize for human legibility, not just uniqueness

The system should distinguish two questions:

1. **How do we avoid collisions?**
2. **How does a human immediately understand what a run is for?**

The current timestamped task-dir model answers the first question well, but only partially answers the second.

For comparison runs, canonical naming should include both:

- a **human-readable intent slug** describing what the work is about
- a **variant label** identifying the sibling run (for example `claude`, `codex`, `candidate-a`)

Recommended formula:

- branch: `<flow>/<ticket-or-pr>-<intent-slug>-<variant>`
- task dir: `<task-root>/<flow>/<ticket-or-pr>-<intent-slug>-<variant>-<timestamp>/`

Examples:

- `fix/proj-2830-funding-activity-claude`
- `fix/proj-2830-funding-activity-codex`
- `review/41672-client-not-initialized-candidate-a`

Task directory naming should keep timestamp uniqueness but also carry the same human-readable slug and variant.

Examples:

- `tasks/fix/proj-2830-funding-activity-codex-0413-1430/`
- `tasks/review/41672-client-not-initialized-claude-0413-1432/`

The point is not only uniqueness; it is **human legibility** when several sibling runs exist, so an operator can tell at a glance what each branch/run is trying to prove.

### 5. Task directories: current system vs ideal system

#### Current system (documented reality)

Farmslot is currently **flow-first** on disk:

- `tasks/fix/<ticket>-<timestamp>/`
- `tasks/review/<pr>-<timestamp>/`
- `tasks/pr-complete/<pr>-<timestamp>/`

Why this exists today:

- flow type maps directly to worker template selection
- operational pipelines are defined per flow type
- task archives are easy to browse by workflow kind
- migration cost is low because most code/docs already assume this layout

Strengths:

- simple and already implemented
- aligns with pipeline execution semantics
- timestamped directories naturally preserve repeat attempts

Weaknesses:

- related work for one ticket/PR gets split across multiple folders
- comparison siblings are harder to see as one coherent set
- humans usually think in terms of “everything for PROJ-2830 / PR 41672,” not “everything for fix flow”

#### Ideal system (recommended target state)

The ideal product model is **family-first conceptually**, even if storage stays flow-first initially.

That means the system should behave as if there is one visible family containing:

- the root fix/dev run
- review siblings
- pr-complete follow-ups
- merge-main follow-ups
- self-review / CI-fix subpasses
- comparison variants

The recommended near-term path is:

- **keep flow-first storage for compatibility**
- **add explicit family metadata and family indexing**
- make UI/history/comparison features present runs family-first

In other words:

- **storage may stay flow-first for now**
- **the user-facing model should become family-first**

This is the lowest-risk migration path because it preserves current filesystem expectations while moving the product toward the more intuitive conceptual model.

### 6. Review/fix/follow-up flows are modeled as relationships, not unrelated flow types

The existing flow types remain useful, but their relationship should be explicit:

- `fix-bug` / `dev` — primary work-producing flows
- `review-pr` — review-oriented sibling of a PR state, not a different ticket family
- `pr-complete` — maintenance / follow-up run on an existing PR
- `merge-main` — maintenance / follow-up run on an existing PR branch
- self-review — an internal quality pass attached to a worker run, not its own family root
- CI-fix — a follow-up artifact/task within the same PR-complete family, not a separate conceptual lane

Recommended model:

- `fix-bug` / `dev` typically create the family root
- `review-pr`, `pr-complete`, and `merge-main` should explicitly reference the same `familyId`
- self-review should be recorded as a **phase or child pass** of the current run, not a new family root
- CI-fix tasks are artifacts or subpasses within a `pr-complete` family member

This keeps related work close together conceptually and operationally.

### 7. Slot usage rules become lane-aware

#### Production lane

- prefer stable affinity and conservative reuse
- reject slot reuse when run identity does not match

#### Validation lane

- allow automatic slot scrub/reset when contamination is detected
- optimize for recovering to a known good state quickly

#### Comparison lane

- do not place sibling comparison runs on the same slot/pane unless explicitly scrubbed between them
- prefer distinct slots for distinct variants

The slot contract becomes: a slot should never silently drift between unrelated family members.

#### Branch-affinity nudge for busy production slots (added 2026-04-30)

Production-lane PR flows (`pr-complete`, `review-pr`) extend the conservative-reuse rule with an explicit operator-mediated nudge path. When a dispatch's `targetBranch` matches the branch of a slot whose worker is actively running (`agent === 'working'`, lifecycle not in `manual`/`disabled`/`held` — note that `lifecycle === 'busy'` is _not_ the gate; busy is a transient prepare/dispatch state, while a worker mid-task sits at `lifecycle: ready, agent: working`) and the slot's runner supports tmux nudges (Claude today via `supportsTmuxNudges`), the operator is shown four explicit actions:

- **Nudge worker** — skip PREPARE; `nudgeDispatch` writes the new `TASK.md` to the worker's task path and sends the read/execute prompt into the existing tmux session via `sendRunnerInstructionSafely(..., { forceBusyPoll: true })`. Preserves the worker's already-loaded PR context (typically 80-150k tokens of bugbot/CI history) instead of paying the prepare + relaunch cost on a clean slot.
- **Kill & dispatch fresh** — bind the busy slot, run PREPARE + DISPATCH normally (existing pane-teardown path).
- **Pick different free slot** — degrade to the existing slot-picker.
- **Abort.**

Surfacing happens in two places:

1. **Dispatch wizard** (human flow) — `dispatch.candidates` returns busy branch-matched slots inline with `nudgeEligible: true` + `nudgeMeta` (uncommitted-files count, `ctxPct`, `nudgeCount`, PR-vs-branch-slug match kind, risk flags). The wizard renders these rows distinctly with per-row action buttons. Picking "Nudge" issues `run.create` with `nudgeReuse: true` + `slotId` set; FIND_SLOT honors the flag and skips its decision-card path.
2. **Decision card** (headless flow) — for entry points without a wizard (CI-watch chained `pr-complete` after CI fail, CLI dispatch, gateway restart recovery), FIND_SLOT emits a `branch_affinity_nudge` decision before scoring free slots. The card carries the same payload shape so the operator's choice produces the same downstream effect.

Constraints carried over from §7:

- Comparison-lane requests skip the nudge candidate finder entirely — sibling comparison runs still require explicit scrub between them, and we do not introduce an exception.
- Only runners with `supportsTmuxNudges: true` qualify (Claude in v1). Codex/OpenCode busy slots silently fall through to scoring; their nudge model is `--continue` re-exec, not send-keys, which is a separate design.
- Uncommitted-files count is fetched via `git status --porcelain` on the slot before the wizard row / card is shown, so the operator sees what they may stomp.

The prior Run on the slot is not modified — its run-monitor handles its own end-of-life independently. The new Run is the system of record; `nudgeDispatch` reassigns `current_run_id` on the slot with an explicit log line so the identity stomp is auditable. This is the only documented exception to the slot-identity invariant in §7.

Out of scope for this ADR (tracked separately on the roadmap): auto-nudge without operator confirmation; cross-PR nudging; fixture-drift probe before nudge; structured family-observability ledger entry for nudge resolution outcomes.

## Alternatives Considered

### A. Keep a single duplicate-run rule for every scenario

**Rejected.**

This is simple, but it makes comparison work awkward and pushes people into unsafe manual workarounds.

### B. Treat validation and comparison as ad hoc flags instead of lanes

**Rejected.**

Flags are useful implementation details, but the product/documentation problem is conceptual. Operators need a simple vocabulary for what kind of run they are doing.

### C. Model every follow-up as a brand-new unrelated run

**Rejected.**

This loses the relationship between `fix-bug`, `pr-complete`, `merge-main`, self-review, and CI-fix, and it makes contamination/recovery logic harder rather than easier.

## Consequences

### Positive

- Similar/comparison work becomes documented instead of improvised
- Duplicate-run behavior is understandable and intentional
- Follow-up runs become easier to group, inspect, and compare
- Slot contamination prevention has a clearer product-level contract
- The UI can eventually present related runs as one family rather than disconnected records

### Negative

- More metadata is required on runs and slots
- Branch/task naming conventions become stricter for comparison work
- Some current code paths will need follow-up implementation to fully realize the model

## Initial Implementation Guidance

**Recommended direction:** preserve the current flow-first on-disk layout in the short term, but treat run families as the canonical product model everywhere else.

1. Keep production behavior as the default.
2. Add explicit lane metadata to runs.
3. Add family metadata (`familyId`, `variant`, `parentRunId`) to runs.
4. Make the duplicate-run guard lane-aware.
5. Make comparison branch/task naming explicit and machine-enforced.
6. Keep self-review as a phase/child pass, not a family root.
7. Treat `pr-complete` and `merge-main` as follow-up family members of an existing PR/ticket lineage.

### Phase 1 slice: family-context inheritance for follow-up runs

Before implementing the full lane/family model everywhere, the first practical slice should focus on **context inheritance for follow-up runs**.

Recommended Phase 1 behavior:

1. Add the minimal family metadata needed for lineage:
   - `familyId`
   - `parentRunId`
   - `familyRootTicketOrPr`
   - optional `lane`
   - optional `variant`
2. Ensure chained follow-up runs (`review-pr`, `pr-complete`, `merge-main`) preserve the same `familyId` and point back to the parent/root run.
3. Teach the task writer to resolve original-family artifacts and inject them into worker prompts as inherited context, rather than forcing the worker or human to rediscover them manually.
4. Require follow-up worker templates to explicitly evaluate whether the current run addresses the **full original family scope** or only a **partial symptom**.
5. Prefer family-context inheritance over shallow artifact copying. The goal is not merely “copy `learnings.md` into the new folder”; the goal is to preserve the reasoning context of the original work so later runs can make correct decisions.
6. Prefer **resolve → materialize → reference** over prompt inlining. If inherited context is found outside the current task folder, the system should copy or synthesize it into the current task's local assets/context area and then pass only the resulting file path to the worker.

This slice is intentionally narrower than full ADR-024 implementation, but it captures one of the highest-value failures observed in practice: a `pr-complete` or review-oriented follow-up run failing to realize that the latest comment only covers a small section of the original bug/task.

### Inherited artifact resolution order

For follow-up runs that need prior validation or reasoning context, inherited artifacts should be resolved in this order:

1. **Current task artifacts** — if the current run already has the needed file, use it directly.
2. **Family-root artifacts** — prefer the original bugfix / family-root task outputs when present.
3. **PR body / PR description embedded context** — if the family-root task artifact is missing but the PR body contains a structured `Validation Recipe` (or similar structured inherited artifact), extract it.
4. **Other family-member artifacts** — only when the above sources are unavailable.

When a fallback source such as the PR body is used, the system should materialize the extracted content into a file in the current task folder (for example under `assets/inherited/` or another dedicated context directory) and record the provenance. Workers should consume the materialized file path, not a large copied block inside the prompt.

## Validation Guidance

When validating the new model:

- prove production lane still rejects accidental duplicates
- prove validation lane can auto-resolve routine decisions without mutating production semantics
- prove comparison lane can run sibling variants without task-dir/branch ambiguity
- prove slot identity detects contamination before worker launch
- prove follow-up runs inherit the original family context strongly enough to distinguish “partial symptom fixed” from “full original bug fixed”

Validation for this ADR does **not** require a permanent live E2E harness. A targeted live proof against real gateway state, real PR data, and the real PR/run UI surfaces is sufficient when it verifies the relevant milestone states and slot-safety expectations. A reusable live harness may be added later if it proves worth the maintenance cost, but it is not a requirement of this ADR.

## Follow-up Implementation Implications

This ADR does not require immediate full implementation, but it implies future work in at least these areas:

- `Run` model: add family/lane metadata
- task writer / prompt rendering: inject original-family artifacts and inherited context into follow-up runs
- duplicate-run guard in `methods/run.ts`: make lane-aware
- task writer: support variant-aware task dir naming
- branch generation: support explicit comparison suffixes
- slot state: continue using run identity fields and align them with family metadata
- UI: show family/variant relationships and compare siblings intentionally
- optional later hardening: scriptable live certification for PR/family milestone behavior, if the team decides the maintenance cost is justified

---

## Addendum: CI-Watch Auto-Dispatch and Slot Hold Strategy

**Added:** 2026-04-15

### Problem

ci-watch currently creates human decisions for every detected issue (CI failures, merge conflicts, bot comments). The operator must approve chaining a pr-complete or merge-main run even for clearly auto-fixable problems like lint errors or simple conflicts. This blocks the pipeline on human attention for mechanical work.

Additionally, the system holds slots in `ci-watch` phase for up to 2 hours regardless of CI outcome. When CI has passed and the only remaining blocker is human review (which may take days), the slot is wasted.

### Decision: auto-dispatch for known-fixable categories

ci-watch should **auto-dispatch** the appropriate chained run (pr-complete or merge-main) without creating a human decision, for configured issue categories:

| Issue Category                            | Current                               | New Default                   |
| ----------------------------------------- | ------------------------------------- | ----------------------------- |
| CI failures (lint, format, type errors)   | Inline fix (already auto)             | Same                          |
| Test failures                             | Decision → human approves pr-complete | **Auto-dispatch** pr-complete |
| Merge conflicts                           | Decision → human approves merge-main  | **Auto-dispatch** merge-main  |
| Bot comments (bugbot, sonarcloud, CLABot) | Decision → human approves pr-complete | **Auto-dispatch** pr-complete |
| Human review comments                     | Decision → human approves pr-complete | Decision (keep manual)        |

Human review comments remain manual by default — a human chose to write them, a human should decide how to respond. This slice does not add human-comment auto-dispatch.

Auto-dispatched runs are family members of the original run. They inherit `familyId` and `parentRunId`, and benefit from Phase 1 family-context inheritance (report.md, learnings.md, recipe.json from the parent). This directly addresses the context-loss problem: chained workers start with the original worker's reasoning artifacts, not from scratch.

### Decision: slot hold strategy — release after CI passes

The slot hold contract for all primary work flows:

| Phase                                            | Slot State                  | Duration                                 |
| ------------------------------------------------ | --------------------------- | ---------------------------------------- |
| Worker active (DISPATCH → MONITOR)               | `busy`                      | Until worker finishes                    |
| Short watch (CI running + auto-dispatched fixes) | `held`, phase `ci-watch`    | Minutes to configurable max (default 2h) |
| CI green, no actionable work                     | Released (`keepWarm: true`) | Immediate                                |
| Long watch (awaiting human review)               | Released                    | Until re-activation                      |

**Short → Long transition:** CI passes AND no pending auto-dispatch chains → release slot immediately.

**Long → Short re-activation:** New event (webhook or manual dispatch) → create pr-complete run with family-context → claim slot via affinity or fresh allocation.

No slot is held waiting for human reviewer activity. Human review is always long-watch territory.

### Decision: keep all flow types

All five flow types (fix-bug, review-pr, dev, pr-complete, merge-main) remain. Each has its own worker template (11+ steps), its own Run object, its own step I/O and artifacts. The observability and failure isolation this provides is worth the ~30-60s chaining overhead per follow-up run.

What changes is not the flow types themselves but how they are **triggered**: auto-dispatch replaces human decisions for configured categories.

### Per-project configuration

```jsonc
// project.json
{
  "ci_watch": {
    "poll_interval_s": 60,
    "max_hold_min": 120,
    "auto_dispatch": {
      "test_failures": true,
      "merge_conflicts": true,
      "bot_comments": true,
    },
  },
}
```

### Implementation phases

1. **Auto-dispatch in ci-watch** — add `ci_watch.auto_dispatch` config; skip decision creation for enabled categories, directly chain the appropriate run
2. **Slot hold strategy** — release slot immediately after CI passes; add `ci_watch.max_hold_min` safety timeout
3. **Family-context inheritance** — (same as Phase 1 above) chained runs inherit parent artifacts
4. **Webhook integration** (separate) — GitHub webhook receiver to auto-create pr-complete runs when events arrive for completed PRs

---

## Addendum: Interactive PR-Complete Re-Entry

**Added:** 2026-06-08

### Problem

`pr-complete` has two valid operator intents:

1. **Autonomous follow-up** — fix CI, bot comments, or mechanical review feedback, push, reply, and terminal-signal completion.
2. **Interactive re-entry** — reopen an existing PR/run, reload prior family artifacts such as recipes and reports, perform the normal PR-complete preparation/fix/validation work, then stop before terminal completion so the operator can inspect or do manual work.

Before this addendum, `pr-complete` behaved as an autonomous template even when `run.mode` was `interactive`, so manual re-entry could accidentally run through push/reply/signal completion.

### Decision

Keep `flowType:'pr-complete'` as the single PR follow-up flow and use `mode` for autonomy:

- `mode:'autonomous'` keeps the existing automated PR-complete behavior.
- `mode:'interactive'` selects a project-owned `pr-complete-interactive.md` template when present.
- If an interactive template is absent, the task writer still appends an interactive handoff contract that overrides terminal completion instructions.
- Interactive PR-complete must still resolve/materialize family context using the existing ADR-024 inheritance model (`inputs/inherited-context.json`, `inputs/inherited/`, seeded `artifacts/recipe.json` when available).
- Interactive PR-complete must stop before terminal `SIGNAL.json`; the operator owns final completion after manual inspection/work.

The dispatch UI may default ordinary PR-complete dispatches to autonomous while exposing the same Interactive/Autonomous mode selector used by other flows.

## References

- ADR-013: gateway-mediated orchestration
- ADR-018: interactive vs autonomous modes
- ADR-022: slot lifecycle simplification
- ADR-023: runner-agnostic TUI-first execution
- `services/gateway/src/run-engine.ts`
- `services/gateway/src/ci-monitor.ts`
- `services/gateway/src/task-writer.ts`
- `services/gateway/src/methods/run.ts`
