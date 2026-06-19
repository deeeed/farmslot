# Companion Evidence-First UX Simplification Plan

Status: Active plan for the Mobile Companion evidence-first UX PR.
Canonical scope: supports `docs/PRD-mobile-companion-canonical.md` and `docs/ROADMAP-next.md` operator UI/UX stabilization.
Lifecycle: keep until the evidence-first mobile UX ships, then promote durable outcomes into the mobile PRD / implemented history and delete this plan.

## Problem

The Companion currently exposes many Command Center-like surfaces as first-class phone tabs. That preserves power-user access, but it makes the default mobile path noisy for the main remote job: validate visual evidence, inspect diffs, and steer the worker terminal quickly.

## Product direction

Make Companion a phone-native review-and-steer app by default:

1. **Review first** — one default queue for active runs, PR evidence, family retros, and ready/review gates.
2. **Evidence first inside details** — before→after screenshots/videos are the hero, not pipeline internals.
3. **Diff and terminal are sibling tabs** — evidence, diff, timeline, terminal, and files are switchable within one review package.
4. **Advanced mode keeps parity** — Fleet, raw Runs, broad PR dashboard, Inbox filters, Co-Pilot, and diagnostics move behind Advanced/More instead of disappearing.
5. **Recipe evidence is mandatory for UX work** — each feature slice captures before/after screenshots for the impacted screens.

## Baseline screenshot recipe

New entrypoint:

```bash
cd apps/companion
yarn recipe:run:ux-baseline:android
yarn recipe:run:ux-review-flow:android
```

Baseline proof captured on Android from this branch:

```text
apps/companion/.agent/recipe-runs/ux-baseline-android-2026-06-19T16-14-54-212Z/artifact-manifest.json
```

First signal from the baseline: the default Active screen already shows the
noise problem clearly — global filters, six bottom tabs, family/run nesting,
many chips, and multiple parallel action buttons compete with the main job of
opening evidence, diff, or terminal.

Direct script, useful while iterating:

```bash
cd apps/companion
FARMSLOT_UX_SCREENSHOT_DIR=.agent/ux-baseline-screenshots \
  bash scripts/screenshots/capture-ux-baseline-screenshots.sh --android-only
```

Optional route context for deeper flows:

```bash
UX_RUN_ID=<run-id> UX_SLOT_ID=<slot-id> UX_FAMILY_ID=<family-id> \
  yarn recipe:run:ux-review-flow:android
```

The first recipe captures default tabs. When IDs are provided, the script also captures run detail, evidence, diff, slot workspace, terminal, slot diff, and family workspace routes.

## Feature slices

### Slice 1 — Navigation simplification

Goal: reduce default bottom-tab noise.

Recommended default IA:

- `Review` — default queue and active review packages.
- `Terminals` — worker/tmux access with related workers first.
- `Settings` — pairing, profiles, diagnostics.
- `Advanced` or `More` — Fleet, raw Runs, PR dashboard, Inbox, Co-Pilot, filters.

Acceptance criteria:

- First launch after pairing lands on Review, not a raw dashboard.
- Advanced surfaces remain reachable in ≤2 taps.
- Existing deep links keep working.
- Before/after screenshots show fewer default tabs and less filter/header chrome.

Slice 1 evidence captured on Android from this branch:

```text
Before: apps/companion/.agent/recipe-runs/ux-baseline-android-2026-06-19T16-14-54-212Z/artifact-manifest.json
After:  apps/companion/.agent/recipe-runs/ux-baseline-android-2026-06-19T16-33-26-754Z/artifact-manifest.json
```

### Slice 2 — Review package shell

Goal: one shared detail model for run/family/PR/decision evidence.

Tabs:

- Evidence
- Diff
- Timeline
- Terminal
- Files

Acceptance criteria:

- Run detail opens to Evidence by default.
- Run and decision workspaces use the same tab labels/order.
- Pipeline/JSON/supporting files are not visible until Timeline/Files/Advanced.
- Sticky actions expose `Open diff` and `Terminal` when available.

Slice 2 evidence captured on Android from this branch:

```text
Before: apps/companion/.agent/recipe-runs/ux-review-flow-android-2026-06-19T17-29-17-416Z/artifact-manifest.json
After:  apps/companion/.agent/recipe-runs/ux-review-flow-android-2026-06-19T17-48-28-786Z/artifact-manifest.json
```

Result: run detail now shows an evidence-first `Review package` rail with
Evidence, Diff, Timeline, Terminal, and Files actions. Pipeline, raw run
artifacts, recipe groups, and metrics move behind Timeline/Files. Artifact and
diff routes suppress transient Android background-pause refresh noise while
retaining cached review content.

### Slice 3 — Evidence viewer upgrade

Goal: make before→after and videos easy to validate.

Recommended changes:

- Make before→after rail the hero area.
- Show videos inline with obvious play state and fullscreen affordance.
- Add a compact evidence completeness row: visual pairs, videos, diff, review report.
- Move filter chips below the hero or into Files.

Acceptance criteria:

- Operator can identify the primary visual delta without scrolling past metadata.
- Fullscreen media opens from both before and after panes.
- Missing evidence has a clear “what is missing” empty state.

### Slice 4 — Diff + evidence coupling

Goal: make code diff and visual proof mutually reinforcing.

Recommended changes:

- Diff tab starts with changed-file summary and PR link/state.
- Evidence thumbnails stay visible or one tap away from each file group.
- Visual review files and textual diff files are sorted above setup/log noise.

Acceptance criteria:

- From any visual pair, operator can jump to diff.
- From diff, operator can jump back to evidence.
- PR number/repo/status are visible without opening a separate PR dashboard.

### Slice 5 — Contextual terminal steering

Goal: connect to the correct worker/tmux pane from the review context.

Recommended changes:

- Terminal tab inside review package selects the linked slot/worker when known.
- Terminal list prioritizes workers related to current run/PR/family.
- Sticky terminal actions: keyboard, control keys, copy context, voice nudge.

Acceptance criteria:

- From a run/PR review package, opening Terminal lands on the relevant worker when available.
- Stale/unavailable terminal state explains next action.
- Existing all-worker terminal remains under Terminals/Advanced.

### Slice 6 — Advanced mode and diagnostics cleanup

Goal: keep power surfaces without default noise.

Recommended changes:

- Move raw Fleet, full Runs list, full PR dashboard, global filters, and environment cards to Advanced.
- Settings keeps pairing and current connection first; environment/update diagnostics lower.

Acceptance criteria:

- Default path has no global filter bar unless user enters Advanced/raw lists.
- Pairing/profile status remains easy to find.
- No existing diagnostic route is removed.

## Validation loop

For each slice:

1. Capture baseline with `yarn recipe:run:ux-baseline:android` and route IDs where relevant.
2. Implement the slice.
3. Capture after screenshots with the same recipe and route IDs.
4. Attach recipe artifact paths to the PR body.
5. Run `yarn --cwd apps/companion typecheck`, `yarn --cwd apps/companion test:lib`, and any touched component tests.

## Open implementation questions

- Should `Advanced` be a bottom tab or a row inside Settings?
- Should mobile allow approval actions directly, or should it prioritize terminal nudges and evidence review first?
- Which route should become the post-pairing landing page when there are no active reviews?
