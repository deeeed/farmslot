---
name: fs-cross-review-loop
description: 'Interactive tmux-only cross-runner review orchestrator for day-to-day PR hardening. Coordinates a worker pane, a fresh same/similar-runner review pane, and an optional different-runner review pane until all blocking findings, including nits, are fixed.'
status: manual-usable
---

# FS Cross-Review Loop

This skill is a **tmux-only interactive orchestrator** for day-to-day bugfix/PR hardening.

The orchestrator must **never execute the work itself**. It does not inspect the repo directly, run tests, run `git diff`, edit files, judge code, or decide that a finding is technically wrong. Its job is only to coordinate independent review panes, capture their output, relay findings back to the worker pane, reset the review panes after each fix pass, and repeat until the PR is clean.

Gateway automation is a later productization path. The manual tmux workflow in this skill is usable now.

## Core Model

Use up to three tmux panes:

1. **Worker pane**: the main agent that writes code, runs relevant validation, updates evidence, and fixes review findings.
2. **Same/similar-runner review pane**: a fresh reviewer using the same runner family or a similar runner profile as the worker, but with a clean review prompt and no authority to edit.
3. **Different-runner review pane**: optional. A reviewer from a different runner family, for example Claude reviewing Codex work or Codex reviewing Claude work. Define whether this pane is enabled during the interaction.

The leader/orchestrator is a router, not a reviewer and not an executor:

- watch the worker pane until the worker says the PR is ready for review;
- ask the worker and review panes to inspect the current diff, task, acceptance criteria, evidence expectations, and validation;
- collect review output;
- consolidate every blocking finding into one clear fix request without changing reviewer meaning;
- send that request to the worker pane;
- after the worker fixes the findings, reset the review pane(s) and make them review the current PR from scratch;
- stop only when required reviewers return clean and the worker has fresh validation/evidence.

## Hard Orchestrator Boundary

The orchestrator is allowed to:

- discover tmux panes;
- capture pane output;
- send prompts/messages into assigned panes;
- summarize reviewer findings without changing their meaning;
- maintain a loop log if an artifact directory already exists.

The orchestrator is not allowed to:

- run repo commands such as `git diff`, `npm test`, `yarn`, `pnpm`, `tsc`, recipes, linters, validators, or evidence capture;
- open the codebase to perform its own review;
- edit files;
- fix findings;
- dismiss findings as invalid on its own authority;
- add new technical findings that did not come from a reviewer;
- mark the PR clean unless required review panes say `PASS` and the worker confirms validation/evidence.

If information is missing, the orchestrator asks the worker or a review pane to produce it. It does not produce the technical evidence itself.

## When To Use

Use this skill when:

- a real bugfix PR is approaching review and you want fewer human review loops;
- the worker may be missing nits, P2/P3 issues, recipe mismatch, or weak visual evidence;
- you want one orchestrator to keep Claude/Codex/OpenCode-style panes in a disciplined ping-pong loop;
- you can see or control the relevant agents through tmux panes.

Do not use this skill when:

- you are not in tmux or cannot identify stable pane IDs;
- the change is docs-only and does not need a second review pass;
- the worker has not produced a reviewable diff;
- you need the orchestrator itself to inspect code, fix code, or run validation.

## Required Interaction

At the start, identify or ask for exactly these decisions:

- worker pane: tmux pane ID or window/pane target for the main fixer;
- same/similar review pane: tmux pane ID or whether the orchestrator should create/select one;
- different-runner review pane: enabled or skipped; if enabled, pane ID and runner type;
- max review cycles before escalating to the human, default `3`;
- whether recipe/evidence review is in scope, default `yes` for bugfix PRs;
- whether reviewers may run commands, default `read-only shell inspection only`; validators belong to the worker.

This setup interaction is about pane routing and loop policy only. The orchestrator must not inspect the repository or pre-review the diff while setting up the loop.

Record the setup before cycle 1 starts. If a task artifact directory exists, initialize from:

- `templates/cross-review-loop.md`
- `templates/CROSS-REVIEW-LOOP.json`
- `templates/CROSS-REVIEW-LOOP.schema.json`

If no artifact directory exists, keep the same fields in the leader's working notes and include them in the final summary.

Useful pane discovery commands for the orchestrator:

```bash
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pane_current_path} #{pane_current_command} #{pane_title}'
tmux capture-pane -p -t %pane -S -80
```

These tmux commands are the only command category the orchestrator should run directly. Any code, git, test, recipe, or evidence command must be requested from a worker or reviewer pane.

## Manual Loop Protocol

1. Wait for the worker pane to report ready for review.
2. Reset the review panes to fresh context.
3. Ask the same/similar review pane to review the current PR from scratch.
4. Ask the optional different-runner review pane to review from scratch when enabled.
5. Capture reviewer findings.
6. Dispatch one consolidated fix request back to the worker pane.
7. Wait for the worker to fix, validate, and report ready.
8. Reset reviewers and repeat from scratch until required reviewers return clean.

## Severity Policy — mandatory fixes

Every review pane must treat each item as **blocking** in these buckets:

| Severity   | Action                         | Why                                  |
| ---------- | ------------------------------ | ------------------------------------ |
| P0 / P1    | Block run, feedback to worker  | Correctness                          |
| P2         | Block run, feedback to worker  | Medium-term regression risk          |
| P3         | Block run, feedback to worker  | Small cost now << cleanup cost later |
| nit        | Block run, feedback to worker  | Accumulate into slop if deferred     |
| style-only | Non-blocking, note in feedback | Formatter territory                  |

Only `style-only` items may be deferred. Everything else must round-trip through a fix pass.

Rationale: farmslot review agents already produce P2/P3/nit lists but the worker historically closes them as "skipped per time budget". That erodes the signal of the feedback file — once skips are normalized, Layer 1 becomes theater. Mandatory remediation keeps the review file truthful.

## Validation Contract

Every fix cycle re-validates, but not every fix cycle runs the canonical gate. Running the full
`yarn quality` on each round saturates the machine and delays reviewer feedback for no added
coverage — the intermediate rounds already have a changed-file lane.

- Intermediate rounds: run the exact affected tests for the changed files, then `yarn prepush:quality`.
- Final round: run the full `yarn quality` once on the final committed SHA.

"Exact affected tests" means the specific test files covering the changed source — for example
`node --test scripts/quality/run-tsx-tests.test.mjs`, or
`node scripts/quality/run-tsx-tests.mjs --cwd services/gateway --tsconfig tsconfig.json <file>.test.ts`
for a single Gateway suite. Do not substitute a whole-workspace `quality` script for this.

`yarn prepush:quality` is the existing path-filtered lane
(`scripts/quality/prepush-quality.mjs`). Do not build or ask for a second changed-file selector.

The orchestrator does not run any of these — it requires the worker to report which commands ran
and with what result before dispatching the next review round.

This contract is machine-checked by `yarn quality:review-loop`
(`scripts/quality/check-review-loop-validation-contract.mjs`), which runs inside the canonical gate.

## Reviewer Prompt Template

Use this shape for each review pane. The reviewer owns inspection; the orchestrator only sends the prompt and relays the result.

```markdown
# Cross-Runner PR Review

You are an independent reviewer. You are in read-only review mode unless explicitly told otherwise.

Review the current branch from scratch. Do not rely on any previous verdict.

The orchestrator will not run commands or inspect code for you. If you need evidence, request it in your verdict for the worker to provide.

Inputs to inspect:

- task / acceptance criteria / PR description if available;
- current git diff and changed files;
- worker validation summary;
- recipe/evidence artifacts, screenshots, or videos when relevant;
- previous-cycle findings only to verify they were fixed, not to shortcut review.

Return exactly:

## Verdict

PASS or ISSUES

## Findings

- [severity: P0|P1|P2|P3|nit|style-only] [file:line or artifact] finding and why it matters

## Evidence Review

- visual/recipe proof is sufficient, weak, missing, or not applicable

## Validation Review

- validation is sufficient, weak, missing, or not applicable

Rules:

- Do not edit files.
- Do not run long validators unless the orchestrator explicitly allows it.
- Include nits. Nits are blocking in this workflow unless they are pure formatter style.
- Prefer concrete, fixable findings over broad redesign advice.
```

## Worker Feedback Template

```markdown
# Cross-Review Fix Cycle {{cycle}}

The reviewers found blocking issues. Fix all blocking items before asking for another review.

## Required Fixes

{{findings_grouped_by_reviewer}}

## Evidence / Recipe Gaps

{{evidence_findings}}

## After Fixing

- run the exact affected tests for the files you changed, then `yarn prepush:quality`;
- do not run the full `yarn quality` for an intermediate cycle;
- update or confirm visual/recipe proof if relevant;
- summarize what changed;
- say "ready for cross-review cycle {{next_cycle}}" when done.
```

## Stop Criteria

Stop with `clean` only when:

- worker reports implementation complete;
- required review panes return `PASS` with no blocking nits/P2/P3/P0/P1;
- recipe/evidence expectations are satisfied or explicitly documented as not applicable;
- worker confirms the full `yarn quality` has been run once on the final committed SHA;
- no reviewer has unresolved concrete findings.

Escalate to the human when:

- max cycles are reached;
- reviewers disagree on a product/design decision;
- the worker cannot reproduce or fix a finding;
- the PR requires external credentials, devices, or production access the orchestrator cannot inspect;
- review panes are not stable enough to trust.

## Compose dispatch (required)

Cross-review orchestrators must use [.agents/skills/tmux-model-driver](../tmux-model-driver/SKILL.md). Do **not** send reviewer prompts with raw `tmux send-keys` + `C-m` — Claude/Codex compose treats `C-m` as newline, not submit.

Minimum protocol for every worker/reviewer nudge:

1. Resolve pane id (`tmux list-panes -a -F '#{pane_id} …'`).
2. Run `pane-state.sh <pane-id> [runner]`; resolve launch blockers before composing.
3. Pipe the prompt into `send-and-verify.sh <pane-id> <action-kind>` where `action-kind` is `claude`, `codex`, `cursor`, or `shell`.
4. Re-capture the pane. If verification is `pending_input`, `input_buffered`, or `likely_pending_input`, send named `Enter` again (or `Tab` when Codex shows `tab to queue message`) — never fall back to `claude -p` inside tmux.
5. Treat handoff as successful only when runner progress appears (`Cooking…`, `Pollinating…`, `Effecting…`, `Working (`, tool lines) or the compose box is empty at `❯`.

Long prompts: write to a temp file in the worktree and send a one-line instruction to read it, or use `send-shell-script.sh` for shell launches — do not paste multi-kilobyte prompts through `send-keys -l` in narrow panes.

## Tmux Safety Rules

- Use stable pane IDs such as `%12`, not only window titles.
- Capture before sending input; do not send into a busy pane unless the current task expects it.
- Do not send secrets or production credentials into review panes.
- Do not let review panes write files unless the operator explicitly promotes a reviewer into a worker.
- Do not kill or interrupt a pane unless it is clearly the review pane assigned to this loop.
- **Required:** follow `tmux-model-driver` pane-state checks and `send-and-verify.sh` before every compose send.
- Do not run codebase inspection commands from the orchestrator pane. Ask an assigned review pane to inspect and report.

## Artifacts

When an artifact directory exists, write or ask the worker to write the coordination artifacts. These artifacts must describe routing and verdict state only; they must not invent technical findings, validation results, or evidence quality judgments that did not come from the worker or review panes.

- `artifacts/cross-review-loop.md`
  - cycle number;
  - reviewer pane IDs;
  - reviewer verdicts;
  - findings sent to worker;
  - worker fix summary;
  - final clean verdict;
- `artifacts/CROSS-REVIEW-LOOP.json`
  - `status`: `running`, `clean`, or `escalated`;
  - `cycles`;
  - `requiredReviewers`;
  - `optionalReviewers`;
  - `blockingFindingsOpen`;
  - `finalVerdict`;
  - per-cycle reviewer verdicts, blocking findings sent to the worker, worker fix summaries, and validation summaries.

Update the artifacts at these points:

1. after setup is complete;
2. after each reviewer verdict is captured;
3. after consolidated findings are sent to the worker;
4. after the worker reports fixes and validation;
5. at final `clean` or `escalated` stop.

Keep `CROSS-REVIEW-LOOP.json` valid JSON matching `templates/CROSS-REVIEW-LOOP.schema.json`. Keep `cross-review-loop.md` readable enough for PR evidence review.

## Future Gateway Automation

The same protocol can later be productized in the gateway:

- dispatch-time review-depth config chooses no cross review, same/similar review only, or same plus different runner;
- gateway controls panes and message routing;
- review panes are fresh every cycle;
- the gateway does not review code itself;
- family observability shows review/fix cycles;
- cost analytics tracks reviewer token spend separately from worker and Co-Pilot spend.

Do not implement a one-shot cross-review that cannot repeat after worker fixes. The day-to-day workflow is ping-pong until clean or escalated.

## Related

- PR evidence decoration skill — separate concern, not part of loop
- `tmux-model-driver` skill — **required** for compose dispatch to worker/reviewer panes (submit key, buffered-input retry, progress verification)
