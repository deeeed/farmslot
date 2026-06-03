# Improvement Prompt — Interactive tmux cross-review orchestrator

Use this prompt to improve or productize the `fs-cross-review-loop` skill. The target behavior is a day-to-day manual workflow first, with gateway automation only later.

## Mission

Turn cross-runner review into an **interactive tmux-only orchestrator** that coordinates existing agents. The orchestrator never fixes code, never reviews code directly, never runs repo commands, and never decides whether a technical finding is valid. It only:

- identifies the tmux panes;
- asks review panes to review;
- captures review output;
- sends consolidated findings back to the worker pane;
- resets review panes after each worker fix pass;
- repeats until required reviewers and the worker report a clean PR.

## Pane model

The workflow has up to three panes:

1. **Worker pane**: main fixer. Owns all edits, validation, evidence capture, and final summary.
2. **Same/similar-runner review pane**: required by default. Fresh review context, same runner family or similar runner profile, read-only.
3. **Different-runner review pane**: optional. Fresh review context using a different runner family, for example Claude reviewing Codex work or Codex reviewing Claude work.

The optional third pane is chosen during the interaction. The operator may skip it for cheap/low-risk tasks.

## Non-negotiable boundary

The orchestrator may run tmux-only control commands such as pane discovery, capture, and send-keys.

The orchestrator must not:

- run `git diff`, tests, linters, recipes, validators, package scripts, browser/device automation, or evidence capture;
- open files to review code itself;
- edit files;
- add its own technical findings;
- dismiss reviewer findings as invalid;
- mark clean unless the required review panes say `PASS` and the worker confirms validation/evidence.

If the orchestrator needs information, it asks the worker or a review pane to produce it.

## Interaction contract

At start, collect:

- worker pane ID;
- same/similar review pane ID;
- whether different-runner review is enabled;
- different-runner pane ID and runner type when enabled;
- max cycles, default `3`;
- whether recipe/evidence review is in scope;
- whether reviewers may run lightweight read-only shell inspection or must only reason from worker-provided summaries.

Use stable tmux pane IDs, not titles alone.

## Loop

1. Wait for the worker pane to say the PR is ready for review.
2. Reset review panes to fresh context.
3. Send the same/similar runner review prompt.
4. Send the optional different-runner review prompt when enabled.
5. Capture reviewer verdicts and findings.
6. Consolidate findings without changing meaning.
7. Send one fix request to the worker pane.
8. Wait for the worker to fix, validate, and report ready.
9. Reset review panes and review the new current PR from scratch.
10. Stop only when required reviewers return `PASS` and the worker confirms final validation/evidence.

Every P0/P1/P2/P3/nit is blocking by default. Pure formatter-style comments may be `style-only` and non-blocking.

## Reviewer prompt requirements

Reviewer prompts must say:

- review current branch from scratch;
- do not rely on previous verdict;
- do not edit files;
- report `PASS` or `ISSUES`;
- include severity for every issue;
- include evidence/recipe quality when relevant;
- if evidence is missing, ask the worker to provide it instead of asking the orchestrator to inspect it.

## Worker feedback requirements

Worker feedback must:

- group findings by reviewer/source;
- preserve file/line/artifact references;
- separate evidence/recipe gaps;
- request validation after fixes;
- request a clear "ready for cross-review cycle N" signal.

The worker owns implementation and validation.

## Artifacts

When task artifacts exist, the loop should produce:

- `artifacts/cross-review-loop.md` with pane IDs, cycles, reviewer verdicts, findings sent, worker fix summaries, and final verdict;
- `artifacts/CROSS-REVIEW-LOOP.json` with status, cycle count, required/optional reviewers, open blocking count, and final verdict.

These artifacts record coordination. They are not a substitute for worker validation or reviewer findings.

Use the templates in `templates/` as the stable artifact contract:

- initialize the artifacts after setup;
- update them after each reviewer verdict, worker feedback dispatch, worker fix summary, and final stop;
- keep JSON valid against `templates/CROSS-REVIEW-LOOP.schema.json`;
- never add technical findings that did not come from a reviewer pane.

## Future gateway automation

If productizing this in the gateway, preserve the manual skill's behavior:

- dispatch config chooses review depth: none, same/similar only, or same plus different runner;
- gateway controls panes and message routing;
- review panes are fresh every cycle;
- the gateway does not review code itself;
- family observability shows review/fix cycles;
- cost analytics tracks reviewer token spend separately from worker and Co-Pilot spend.

Do not implement a one-shot cross-review that cannot repeat after worker fixes. The day-to-day workflow is ping-pong until clean or escalated.
