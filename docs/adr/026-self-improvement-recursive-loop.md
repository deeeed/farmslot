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

| Phase   | Scope                                                                                                                                                                            | Status                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Phase 1 | Move grading into retrospective; proof-target checklist; rerun verdict; improvement-trigger stub; converged pill                                                                 | This ADR (UI ships in follow-up PR) |
| Phase 2 | Real improvement-engine wiring per ADR-021 (LLM call, multi-turn chat, diff proposals); delete `grade-form.ts`                                                                   | Later PR                            |
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

## Amendment 1 (2026-10-19): Lessons are signal only

**Status:** Proposed.

### Decision

A lesson changes a template, fixture, review instruction, engine prompt or curated
learnings file only when both hold:

- It comes from a failure seen on a real run that is likely to recur. The run's own
  record (trace, logs, review findings, diff or gate outcome) must show that the
  failure cost a retry, a fix round or a wrong result.
- It changes what a worker, a reviewer or the engine does.

A worker's `learnings.md` is a claim, not evidence. A claim that can't be verified
is dropped, and so is a failure that an existing rule already catches.

The lesson is written once, as one line, where its reader acts. A merged code fix
replaces the instruction. Removing a stale line is preferred to adding one. Run
histories, per-model notes, operator trivia and record-only entries are not lessons.

Workers report under the same bar: one bullet per qualifying failure in the run,
and "none" is a valid answer.

### Consequences

The default task template, every pack's learnings step, the improvement engine's
prompt and bulk retro curation apply this rule. Curated learnings files keep only
lines that change a run, and the engine proposes nothing for noise.

## Amendment 2 (2026-11-06): Curate before drafting

**Status:** Accepted by the lead, 2026-11-06; implementation in this change.

Retrospective acceptance and explicit improvement requests remain the triggers.
At either trigger, the shared router automatically checks domain learning claims against
retained run/review evidence and the configured library. Only confirmed, observed
failures with run id and file:line, a diff-checkable instruction, and recurrence
in two independent tasks/families or a blocker-class money/order outcome qualify.
Confirmation cites a retained check by another actor; the curator cannot confirm
a claim itself. Template improvements retain Amendment 1's existing policy. Existing
coverage is tightened only when evidence establishes a missing check; otherwise
it is dropped. Worker opinion, disputed findings and unavailable evidence do not
qualify. Record each keep/drop and one-line reason in the existing feedback
ledger, separately from consumption. Dropped entries create no human gate, replacing the old all-entries-visible
invariant. Eligible drafting failures retain the existing hold card.

Each eligible draft still requires human approval. Farmslot never writes to the
canonical library. This policy applies to Perps shared rules, repository overlays
and configured harness knowledge libraries. The [learning curation spec](../reference/learning-curation.md)
defines the evidence and ledger contract.

### Public surface

Existing `run.proposeImprovement` and retrospective actions remain unchanged.
Gateway-internal curation and additive local-ledger records introduce no CLI,
RPC or SDK export. Harnesses inherit this policy through their configured
knowledge destination; no per-harness implementation or library writer is added.

## Amendment 3 (2026-11-08): Shared proof-shape feedback before completion

**Status:** Proposed. Scope approved by Arthur, 2026-11-08; review of this amendment precedes implementation.

### Context and decision

The proof dataset and the run-time quality artifact currently disagree: a passing
recipe can receive a quality PASS while its parameterization score is zero.
A retained recipe from an observed production run is such a case. Offline
selection also admits diagnostic recipes without task ACs. Workers discover
these defects too late, after completion, if at all.

One deterministic implementation owns shortness, composition and parameterization
scores, their thresholds, and static task-AC coverage. Run-time quality and the
offline dataset call it; neither keeps a second scoring formula. The contract is
specified in [recipe composition quality](../reference/recipe-composition-quality.md#shared-shape-feedback).

The scorer accepts the recipe, expected registered worker criteria and available
declared library blocks. It returns scores, uncovered ACs and actionable hints identifying literal
fields and duplicated node sequences. Its output records a policy version and
input identities. Equivalent inputs produce equivalent output in both consumers.
Historical mining may suggest new blocks, but cannot silently change the catalog
used to compare a recorded run's shape with its dataset label.

After a task recipe passes, the Farm worker obtains the feedback before terminal
completion, improves the recipe and reruns its proof, or records why a target was
not reached. Shared Farm-generated TASK.md guidance carries this advisory step for recipe-producing
flows, including artifact-only comparison runs. Project checklists may reference
the same guidance without being rewritten. MetaMask/skills and Consensys/skills behavior stays unchanged.

The existing `artifacts/recipe-quality.json` holds an optional `shape` section.
The task-local Farm runtime helper computes it on the slot, using a bounded
snapshot of declared catalog blocks, stored separately as
`artifacts/recipe-shape-catalog.json`. Only digests, counters, scores and hints
travel in `shape`; the bounded catalog is retained as a normal artifact, not
embedded in gate/leaderboard payloads. It preserves existing core artifact fields;
if no artifact exists, the existing builder creates a worker-source advisory
placeholder, not a gateway quality judgment. The gateway continues deriving the
core quality verdict itself, ignoring worker-authored core judgments as before,
but separately recomputes/merges matching shape inputs. Recipe, registered-criteria,
policy and catalog digests must match; mismatches yield stale/unavailable feedback.
The gateway compares source identities against the frozen task binding/receipt
`artifacts/harness-provenance.json`. This verifies identity and self-consistency,
not the completeness of a worker-supplied catalog. Label it worker-supplied and
self-consistent, never certified. The dataset independently reconstructs the
catalog from verified frozen declared sources before imitation selection; if
that is unavailable, eligibility is unknown, not a positive. Portable snapshot
reads use the existing artifact lists; the gateway never reads a remote checkout
as though it were local. Shape warnings stay inside `shape` and
never lower the top-level verdict, semantic grade or leaderboard score. Historical
artifacts without shape remain readable with their prior structural grade; there
is no background catalog rescan or retrospective rewrite. A weak shape or missing static AC binding produces a warning,
not a completion/publication refusal. Existing structural, evidence, deterministic
CI and publication requirements retain their authority. Shape coverage means
that a proving node names each registered AC; it never means that execution or
human judgment proved the AC. Missing criteria or catalog input is explicit,
never a fabricated passing coverage result.

Expected worker criteria come from the existing registered-acceptance projection
of handoff plus acceptance-registration inputs, not from the recipe's own list.
Derived/fresh obligations and inherited qualified parent evidence retain their
existing protocol ownership. Inherited and review-only obligations are reported
separately, never credited as local proving nodes. A recipe cannot exempt an
original criterion by declaring it review-only. Review claims must not gain
`proves` nodes; a task with such locally unprovable obligations gets an explicit
limitation, not fabricated complete coverage.

The dataset uses the same scorer and requires a nonempty, completely locally
covered worker AC set for a task-proof imitation candidate. This conservative
label does not count review-only fresh obligations as recipe-proven; it does not
change their acceptance or completion policy. A passing diagnostic with zero ACs
cannot qualify. Historical runs remain available as reference and repair data;
this does not create labels or automatically promote claims.

### Public surface

- `@farmslot/protocol/recipe-shape.mjs`: browser-safe versioned scoring module, consumed by
  Farm quality and the Python dataset tool through one Node JSON-lines adapter.
  Shared declarations describe its inputs and feedback. This is additive; there
  is no new action, RPC or evidence approval.
- `RecipeQualityArtifact` gains optional structured shape feedback. Version-1
  artifacts without it remain readable. The artifact is still the shared store
  for workers, retrospective views and offline extraction.
- `farmslot-agent recipe-quality feedback --task <task>`: internal Farm task helper that
  reads the bound task recipe, registered ACs and declared library sources,
  writes only the shape contribution to the existing quality artifact and prints the same advice.
  Threshold warnings exit successfully. It does not execute recipes or tests.
- `installedTaskCommands()` exposes overridable `RECIPE_QUALITY_FEEDBACK_CMD`.
  Only Farm generation opts into the advisory line in TASK.md's existing
  “Recipe proof + acceptance review” section. Library-owned CHECKLIST.md bytes and
  their template provenance remain unchanged; the root recipe CLI gains no alias.
- The named offline consumer is the private 12-model-bench `tools/proof_dataset.py`,
  migrated to call the shared module in the same rollout and validated for parity.
- Project harnesses and org skills need no new implementation. The Farm command
  consumes their existing task binding; standalone recipe-quality build remains
  compatible. No org skill is regenerated or changed by this amendment.

### Validation and rollout

First reproduce an observed retained recipe's low score and fix hints in a failing test.
Check dataset/runtime equivalence, missing ACs and diagnostic exclusion. Then use
one authorized Farm run on macpro or mini to observe feedback before completion,
parameterization above 0.7 and a nonempty covered AC set. Preserve its before/after
artifacts. This does not authorize a bulk run, a new hard gate or publication.

## Amendment 4 (2026-11-26): Checked learnings and kinds from results

**Status:** Proposed; implemented in this change at the lead's request. Builds on
Amendment 2, which stays as accepted.

### Context

Amendment 2 curates lessons before drafting. In practice:

- `learnings.md` was checked only for being non-empty (`check-task-artifact-contract.mjs`,
  `validate-package.ts`). The format lived in prose (Amendment 1, the default task template).
- `splitLearningsEntries` treated `- None` and "Nothing new." as lessons.
- The only automatic batch in the live ledger on macwork (2026-11-10, run `6ae37c17`)
  dropped 4 of 4 lessons: "Curation did not return one outcome per learning". Lessons
  went to the model as a bare list and outcomes were matched by position. Replaying
  that run's lessons through the same call dropped the whole batch in 2 of 8 tries:
  the model returned 6 or 9 outcomes for 5 lessons. All 22 recorded landings came
  from manual audits.
- The destination was one path per project, from the first configured library. The rule
  the curator cites for a tightening was checked and then discarded.
  `parseReviewRuleProposal` had no caller outside tests.
- In a test on three finished reviews of one public PR, agents wrote 17 product lessons
  with real `file:line`. 16 cited their own review as confirmation, and at least 15
  pointed at a rule that had already caught the problem.

The review side is decided in MetaMask/decisions ADR 0073: teams own their rules, two
rule types, and the loop shown there.

### Decision

1. **One format, one parser.** `@farmslot/protocol` owns the learnings v1 format and
   its parser (`parseLearnings`, `@farmslot/protocol/contracts/learnings`). The terminal
   artifact contract uses it, and mm-harness's mark will use the same parser, so a run
   with or without Farmslot is checked the same way. A file opts in with its first line,
   `# Learnings v1`; other files are read as today.

   ```md
   # Learnings v1

   - edit: A price hook returned '$---' and a validator read it as a price.
     evidence: metamask-mobile app/components/UI/Perps/hooks/usePerpsLiquidationPrice.ts:102
     family: antipatterns.md#missing-numeric-data-stays-undefined
     confirmation: run <id> artifacts/review-ledger.md:40
   ```

   Field names follow the review rule proposal: `evidence`, `family`, `confirmation`.
   `- None` alone means nothing to report. A fix confirmation names a PR
   (`fix <owner/repo#n>`): a bare commit cannot be told apart from the run's own.

2. **Kinds.** `add`, `edit` and `retire` are the existing proposal kinds; `merge` and
   `stale` stay audit-only. Three more kinds route elsewhere: `recipe-broken` and
   `recipe-missing` go to the harness lane (mm-harness and the recipe libraries),
   `workflow` to templates and tools. Each kind lists the fields it needs: `add` lists
   the families it checked (`examined`), and `recipe-broken` names the recipe node and
   the failed attempt.

3. **The agent's kind is a claim; run results decide.**

   | What the results show                                                              | Kind                  |
   | ---------------------------------------------------------------------------------- | --------------------- |
   | The covering rule recorded a FINDING                                               | none: the rule worked |
   | A confirmed problem no rule covers                                                 | `add`                 |
   | A rule recorded PASS and a later check found the problem                           | `edit`                |
   | A rule's finding was rejected                                                      | `edit` or `retire`    |
   | A recipe failed, then passed on the same product head with only the recipe changed | `recipe-broken`       |
   | A recipe failed and never passed on the same product head                          | a person decides      |

   The review rows are the `artifacts/review-coverage.json` rows of the lesson's run
   family: each family's PASS or FINDING, named by its pack id or its heading's anchor.
   They decide an `edit`; without a row, the claim stands. No retained record yet ties a
   rejected finding to a family, so that row is not decided here and a `retire` claim
   stands; the recipe rows are the harness lane's.

4. **A run never confirms its own lesson.** A confirmation counts only when it points
   outside the lesson's own run: a later run's finding or miss, a merged fix, a rejected
   finding, or a run on a changed recipe. A lesson that cites only its own run or its
   own PR is recorded as unconfirmed and never promoted. The curator applies the same
   rule to free-text lessons: the source run's own review cannot confirm them, while a
   PR comment the run fixed and its reviewer accepted still can.

5. **Targeting.** The domain comes from the files in `evidence`, not from the project
   that ran. A tightening targets the cited family's file and section; a new rule
   targets the client file when the project maps every evidence repo to one client
   (`vars.knowledge_clients`, `metamask-mobile` → `mobile` → `antipatterns.mobile.md`),
   else the shared file. Requirements
   are read for coverage and never edited. A lesson without a clear target is held for
   a person. A kept lesson becomes a `ReviewRuleProposal`, validated by
   `parseReviewRuleProposal` and recorded with its curation receipt.

6. **Rollout.** Warn at every step mark and at completion, while the worker can still
   fix the file. Require v1 per pack only once its template writes it. A finished run
   never fails on format. The Farmslot pack templates and the default task template
   write v1 from this change.

7. **Order of work.** (1) Make the curation call return one outcome per lesson.
   (2) Stop counting `- None` and "Nothing new." as lessons. (3) Parser and checks.
   (4) Kinds from results and targeting, through the existing proposal format and
   ledger. Whether the MetaMask skills ask for v1 is a separate decision for Arthur,
   since it changes skill behaviour.

### Consequences

- Good: lessons arrive in one checked shape, and the same lesson is decided the same
  way with or without Farmslot.
- Good: an agent cannot promote its own opinion, and a rule that worked produces no
  proposal.
- Good: a confused model reply costs only the lessons it confuses, and one run whose
  bundle retention pruned no longer makes the whole curation context unavailable.
- Bad: two formats coexist until each pack's template writes v1. A family's composed
  learnings (a fix round's root, rounds and delta) are read as free text.
- Bad: deciding kinds from results needs the run's review rows and recipe attempts to
  be retained and readable.

### Measures

Report the share of v1 entries with `evidence` and an outside `confirmation`, the
curation keep rate, and rules added per batch with a real failure behind them, not
entry counts.

### Owners

cx-engine for the protocol, curation and targeting; the harness lane for the
mm-harness mark and the recipe kinds, in a separate harness change after this one.
This joins the existing review-rules loop work (F382).

### Public surface

- `@farmslot/protocol`: `parseLearnings`, `LEARNINGS_V1_FORMAT`, `decideLearningKind`,
  `learningConfirmationIsOutside` and their types, also at
  `@farmslot/protocol/contracts/learnings`. `LearningsAntipatternDraft` gains optional
  `targetSection` and `proposal`.
- `@farmslot/agent-runtime`: `scripts/learnings-check.mjs`; `mark` and
  `check-task-artifact-contract.mjs` print `LEARNINGS_V1_WARN` and never fail on it.
- Feedback ledger curation receipts gain optional `unconfirmed` and `proposal`, which
  earlier gateways ignore. No new RPC or CLI.
