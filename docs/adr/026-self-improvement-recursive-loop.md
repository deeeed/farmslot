# ADR-026: Self-Improvement Recursive Loop

**Status:** Proposed
**Date:** 2026-04-17
**Relates to:** [ADR-021](021-llm-enhanced-orchestration.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-025](025-run-family-observability.md)
**Supersedes (in part):** ADR-025 Follow-up #3 ("human grading relocation or reframe inside the observability context")

## Context

Farmslot has three partial pieces of a self-improvement loop, but no ADR wires them into one:

1. **ADR-021** (LLM-enhanced orchestration, §Self-Improving Feedback Loop) — worker writes `artifacts/learnings.md` → retrospective decision → Arthur accepts → improvement-engine fires async → LLM proposes concrete diffs to templates/fixtures/scripts → Arthur iterates via multi-turn chat → apply. Never auto-apply. This defines the **proposal side** of the loop.
2. **ADR-025** (Run family observability) — established the fullscreen retrospective surface at `#family/<id>?run=<id>` as the canonical place to answer "what happened, was it good?" But ADR-025 §Follow-ups #3 explicitly deferred human grading into this surface. So today the retrospective shows evidence, recipe, and learnings — but no grade, no verdict, no improvement trigger. This defines the **surface** without the loop-closing controls.
3. **packages/skills/skills/recipe-cook/references/VALIDATOR-LOOP.md** (landed in commit `2bb6c6c`) — defines baseline cook + validator run artifacts, scoring inputs (`quality`, `pass_rate`, `cost_efficiency`), selection floors (quality ≥ 0.80 AND pass_rate ≥ 0.80), and convergence criteria (stop after 3 consecutive applied patches with <0.02 improvement, OR all three lanes reach ≥0.90/≥0.90). Currently CLI-only (Node scripts in `packages/skills/scripts/`), not wired to UI. This defines the **scoring side**.

What's missing:

- **The grading UX is in the wrong place.** `grade-form.ts` is embedded in `run-detail` (operational live page). Three buttons + reasoning textarea, one-shot, unvalidated, no link to recipe, no link to rerun. Operators describe it as "useless" because it doesn't close any loop.
- **The retrospective has no grading UI.** `family-observability.ts` shows evidence, recipe graph, learnings, rerun, dispatch-fresh — but offers no verdict, no proof-target checklist, no improvement trigger.
- **Rerun produces no verdict.** `_rerunOnWarmSlot()` streams stdout but emits no pass/fail. There's no structured way for a human to record "the rerun actually did what the recipe was supposed to do."
- **Fine-tuning and retrospective artifacts overlap without a documented contract.** `grade.json` and `learnings.md` are read by both the retrospective UI and the fine-tuning dataset extractor. Nothing codifies that this overlap is intentional, so future work risks inventing parallel schemas.

## Decision

Adopt a dedicated, explicitly-wired self-improvement loop anchored on the ADR-025 family observability surface.

### 1. Retrospective is the loop-closing surface

The `family-observability` view at `#family/<id>?run=<id>` is the canonical place where humans grade recipes, propose recipe improvements, trigger reruns, and verdict those reruns. This supersedes ADR-025 Follow-up #3 — grading moves into observability; it is no longer deferred.

`run-detail` keeps its operational role (live status, decisions, drill-down). `grade-form.ts` is retained during migration but no longer the primary grading surface.

### 2. Grading is structured, not free-form

A grade consists of:

1. **Proof-target checklist** — one verdict per `proof_target` declared in `recipe.json` (from the recipe-cook recipe contract). Each row: `pass | fail | not-applicable`, optional note.
2. **Overall semantic** — `good | ok | bad`. Default derived from the checklist (any `fail` ⇒ force `bad`; all `pass` ⇒ suggest `good`). Human may override.
3. **Reasoning** — free text. Required when any target = `fail` OR overall = `bad`.

When `recipe.json` has no `proof_targets`, the checklist falls back to the legacy three-button semantic picker + reasoning. Non-breaking: historical grades without `proof_target_verdicts` render as-is.

### 3. Rerun verdict is a grade on the rerun

A warm-slot rerun produces a new grade payload scoped to the rerun's run id, not the original run. The retrospective renders both (original grade + rerun grade) and highlights deltas per proof target. Reruns without an accompanying grade stay "ungraded" — no silent pass/fail.

### 4. Improvement proposals are gated and iterative

When any graded run has `overall ≠ good` or any proof target failed, the retrospective exposes a **"Propose recipe improvement"** button. Clicking it triggers the ADR-021 improvement-engine flow as a fire-and-forget LLM call against the run's `learnings.md`. The proposal arrives asynchronously as a new `improvement`-typed `RunDecision` broadcast on `run.decision.new`. Never auto-apply. Arthur reviews, iterates via multi-turn chat, and explicitly applies.

Phase 1 of this ADR wires the real improvement-engine call (single-turn, fire-and-forget). The UI surfaces the LLM nature of the call explicitly — model badge, expected duration, async warning, elapsed-time counter. Multi-turn chat for iterating on the proposal remains a Phase 2 item.

### 5. Convergence criteria match VALIDATOR-LOOP.md

A family is **converged** when:

- All graded runs in the family have `overall = good`, AND
- All proof targets pass on a clean rerun (no `fail` in the rerun grade), AND
- (Phase 3, when recipe-cook integration lands) validator-loop convergence holds — per VALIDATOR-LOOP.md, either all three lanes reach `quality ≥ 0.90` AND `pass_rate ≥ 0.90` with cost within 10% of the current best, OR 3 consecutive applied patches produce <0.02 quality improvement.

Note: `quality ≥ 0.80` / `pass_rate ≥ 0.80` in VALIDATOR-LOOP.md are **selection floors** (minimum for accepting a patch into the candidate pool), not convergence thresholds. Convergence uses the stricter 0.90/0.90 criteria above.

On convergence the retrospective renders a "Converged" pill and the "Propose improvement" button stops auto-surfacing.

### 6. Grade storage extends the existing file

Grades persist to `artifacts/grade.json` per run (the file FINE-TUNING.md already defines). Schema extends `HumanGrade` with:

```ts
interface HumanGrade {
  recipe_semantic: 'good' | 'ok' | 'bad';
  reasoning: string;
  graded_by: string;
  graded_at: string;
  proof_target_verdicts?: ProofTargetVerdict[]; // NEW — optional
}

interface ProofTargetVerdict {
  id: string; // proof_target.id from recipe.json
  target: string; // proof_target.target (description)
  verdict: 'pass' | 'fail' | 'not-applicable';
  note?: string;
}
```

Optional field. Old `grade.json` files without it remain valid.

### 7. Data model ownership — retrospective vs fine-tuning

Retrospective and fine-tuning **share one artifact store**, not two. They read the same files; they differ only in query shape and consumer.

**Canonical store** (per FINE-TUNING.md §Data Structure):

```
tasks/<flow>/<id>/
  inputs/       jira.json | pr-meta.json | diff.txt
  artifacts/    recipe.json, report.md, meta.json,
                grade.json, learnings.md,
                line-comments.json, comments-triage.json,
                (recipe-cook validator outputs when a lane is recorded)
```

**Two consumers:**

| Dimension         | Retrospective (ADR-025/026)                 | Fine-tuning (FINE-TUNING.md)                                      |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Reader            | UI snapshot builder + human operator        | Batch extraction script                                           |
| Scope             | One family at a time                        | Whole corpus                                                      |
| Filter            | None — show all                             | `grade==good && validate_exit==0` for SFT; 2+ runs/ticket for DPO |
| Mutability        | Rebuildable from artifacts anytime          | Immutable once labeled                                            |
| Exclusive outputs | LLM family report (optional per ADR-025 §5) | SFT/DPO dataset files                                             |

**Shared signals (deliberate reuse, not overlap):**

- `grade.json` — retrospective uses it as verdict + improvement trigger; fine-tuning uses it as SFT filter. ADR-026's `proof_target_verdicts` enriches both (stricter fine-tune filter; richer retrospective checklist).
- `learnings.md` — improvement-engine (ADR-021) consumes for diff proposals; retrospective surfaces for human read; fine-tuning may later use reasoning as chain-of-thought signal.
- recipe-cook validator outputs (3-lane bundle) — validator loop consumes for scoring; retrospective should render lane results; fine-tuning can use pass/fail per lane as a label.

**Rule:**

> Retrospective is a **view** over task artifacts. Fine-tuning is a **scheduled extraction** over the same artifacts. Nothing is retrospective-only except the optional LLM-generated family report. Nothing is fine-tuning-only except the extracted SFT/DPO dataset.

FINE-TUNING.md will cross-reference this ADR in its "Recipe Quality Evaluation → Level 2 Human grade.json" section so both consumers are visible from either entry point.

## Loop diagram

The flow below is illustrative, not strictly sequential. Reruns can happen directly from the initial grade (to validate a recipe without a new proposal) and proposals can iterate via multi-turn chat before any rerun.

```
Worker run  →  artifacts (recipe.json, evidence, learnings.md, report.md)
                         ↓
Retrospective view  →  human grades against proof_targets
                         ↓                                ↑
          overall == good AND all targets pass? ─ yes ─ Converged, stop
                         ↓ no
          ┌──────────────┴──────────────┐
          ↓                             ↓
  "Propose improvement"          "Rerun on warm slot"
          ↓                             ↓
  improvement-engine (ADR-021)   streams output
          ↓                             ↓
  improvement decision (async)   Human grades rerun (same checklist)
          ↓                             ↓
  Arthur reviews + applies       delta vs prior grade → back to top
          ↓
  Warm-slot rerun  →  (same grading path as above)

                 recipe-cook validator lanes (Phase 3)
                         ↓
          quality/pass_rate/cost_efficiency scoring
                         ↓
           convergence criteria met? ─ yes ─ Converged
```

## Decision Drivers

- Operators need one place to close the improvement loop — grade, propose, rerun, verdict — without context-switching between `run-detail`, the (soon-retired) in-line grade-form, and external CLI scripts.
- The loop must stay human-in-the-loop (never auto-apply improvement proposals), matching ADR-021.
- The loop must reuse existing artifact files (one source of truth for retrospective + fine-tuning), avoiding parallel schemas.
- Convergence must have an explicit, testable definition so "done" is machine-checkable.

## Alternatives Considered

### A. Keep grade-form in `run-detail`; add a separate "loop dashboard" page

**Rejected.** Splits the human's attention across three pages (run-detail for grading, family-observability for review, a new dashboard for iteration). Defeats ADR-025's "one canonical retrospective destination" intent.

### B. Automate the verdict (artifact diff, screenshot compare, recipe-quality.json delta)

**Deferred, not rejected.** Automated verdict is the natural Phase 2/3 extension once proof-target checklists have enough coverage to calibrate automatic checks against. Shipping automated-first risks false confidence when the underlying checks are uncalibrated.

### C. Ship only the ADR, defer all UI

**Rejected.** User feedback is "the current human-gate is useless." Writing an ADR without a visible UX change leaves the pain point untouched for another cycle. Phase 1 UI ships with the ADR to validate the design concretely.

## Consequences

### Positive

- Single surface for the human side of the improvement loop; operators stop asking "where does grading live?"
- Structured grades produce stricter fine-tuning filters automatically — no separate labeling pass needed for proof-target coverage.
- Convergence is machine-checkable; future automation can short-circuit improvement proposals once a family converges.
- Cross-referencing FINE-TUNING.md with this ADR prevents future parallel schemas.

### Negative

- Adds an optional field to `HumanGrade`; gateway/UI must tolerate old `grade.json` files without it. Non-breaking but requires defensive reads.
- Phase 1 improvement trigger is a stub (no real LLM call); requires a follow-up phase to deliver full value. Mitigated by explicit phase labels in the roadmap.
- Retaining `grade-form.ts` during migration means two grading entry points until Phase 2 cleanup.

## Phases

| Phase   | Scope                                                                                                                                                                        | Status                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Phase 1 | Move grading into retrospective; proof-target checklist; rerun verdict; improvement-trigger stub; converged pill                                                             | This ADR (UI ships in follow-up PR) |
| Phase 2 | Real improvement-engine wiring per ADR-021 (LLM call, multi-turn chat, diff proposals); delete `grade-form.ts`                                                               | Later PR                            |
| Phase 3 | recipe-cook validator integration (automated quality/pass_rate/cost_efficiency scoring, 3-lane bundle rendering, convergence math from VALIDATOR-LOOP.md — 0.90/0.90 thresholds) | Later PR                            |

## Phase 3 integration notes

Phase 3 is not currently wired into Gateway in this branch. The package migration keeps
the validator loop CLI under `packages/skills/scripts/`, and the following surfaces
remain the intended integration targets for a later Gateway/UI PR:

**Gateway methods**:

- `family.validator.status` → loads 3-lane bundle + aggregate score vector + convergence state.
- `family.validator.runLane` → spawns a validator lane run through the package CLI; returns `{runId, pid, lane, scenarioId}`.
- `family.validator.ledger` → reads `.omx/state/recipe-cook/runs.jsonl` and returns ledger entries per family/project.

**Events:**

- `family.validator.update` — broadcast when a recipe-cook manifest appears or changes. Payload carries `{familyId, runId, manifestPath, lane, decision, scoreVector, laneSummary, convergenceState}`.

**Manifest watcher target**: a future Gateway watcher tails `.omx/artifacts/recipe-cook-runs/*.json`, matches each manifest to a run by `run_id`/`base_version_id`/`iteration_id`/`task_artifact_dir`, then:

- Appends an auto-resolved `validator_run_complete` RunDecision (payload: lane + score vector + convergence state + manifest path).
- When `manifest.decision === 'keep'` and a patch exists, appends a pending `validator_patch_proposal` RunDecision (payload: patch path + lane summary). Arthur resolves it via the existing `run.resolveDecision` flow (`apply` → `git apply --index`; `reject` → record resolution only).

**Improvement-engine ledger hook target**: once the Gateway integration lands, `applyImprovement()` can append a synthetic JSONL row to `.omx/state/recipe-cook/runs.jsonl` after a successful apply so the improvement path shares the validator ledger. The intended return shape extension remains non-breaking: `recorded?: boolean` + `recordError?: string`.

**UI target** (`ui/src/components/runs/family-observability.ts`): Each lane card in the validator panel should expose a "Run lane" button and an inline SVG sparkline (last ≤20 ledger entries for that lane, quality solid + pass_rate dashed). The run-detail panel should render `validator_run_complete` and `validator_patch_proposal` decisions inline with Apply/Reject wired to `Methods.RUN_RESOLVE_DECISION`. The component should subscribe to `family.validator.update` events and refresh status/ledger/snapshot on the matching family.

**Protocol additions** (`packages/protocol/src/types.ts`): `ValidatorRunCompletePayload`, `ValidatorPatchProposalPayload`, `FamilyValidatorRunLaneParams/Result`, `FamilyValidatorLedgerParams/Result`, `ValidatorLedgerEntry`. `FamilyObservabilityRunSummary` gains an optional `decisions` field so the retrospective can render validator decisions without a separate fetch.

## Follow-ups

1. Screenshot / artifact diff as an automated verdict input (feeds into the proof-target checklist as a pre-computed suggestion).
2. Cross-family improvement aggregation (grade trends per project, model, flow).
3. Companion / mobile grading entry point (still deferred per ADR-025 Follow-up #2).
4. Route `improvement-engine.applyImprovement` through `packages/skills/scripts/record-validator-run.cjs` once its CLI scope accepts `projects/<project>/**` paths; today the gateway writes a minimal ledger row directly.
