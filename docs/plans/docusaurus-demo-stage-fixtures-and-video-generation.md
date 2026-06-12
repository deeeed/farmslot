# Docusaurus demo stage fixtures and video generation

Status: planning support doc
Primary first-slice goal: `docs/plans/docusaurus-first-real-run-video-goal.md`
Parent media goal: `docs/plans/docusaurus-recipe-demo-media-goal.md`

## References

- Farmslot demo issue: https://github.com/deeeed/farmslot/issues/28
- Audiolab demo issue: https://github.com/deeeed/audiolab/issues/414
- Farmslot repo: the Farmslot checkout
- Audiolab repo: `AUDIOLAB_REPO` / `projects/audiolab-farm/project.json`
- EchoBridge repo: `ECHOBRIDGE_REPO` / `projects/echobridge-farm/project.json`
- First video output:
  - `apps/docs/static/videos/demos/command-center-parallel-watch.mp4`
  - `apps/docs/static/img/demos/command-center-parallel-watch.png`

## Why stage fixtures exist

Docusaurus demo videos should come from real runs, but public capture needs controlled data. A **demo stage fixture** is a reversible public-safe runtime profile that makes Command Center, Companion, and app recipes display clean demo state while still exercising real code paths.

The fixture is not fake media. It is setup data for real recipe runs. After capture, the fixture must be removable so local Command Center returns to the normal private/operator state.

## Fixture rules

1. Fixtures may create/select demo tasks, demo run families, demo slots, and demo labels.
2. Fixtures must only show allowed names: Farmslot, Audiolab, EchoBridge, Companion, generic demo machines/slots.
3. Fixtures must not show private repos, private paths, tokens, notifications, work terminals, wallet addresses, customer/Jira data, or private browser state.
4. Fixtures must be applied by a documented command and reverted by a documented command.
5. Recipes must verify the staged view before capture, including a negative assertion for forbidden text.
6. Docusaurus assets are copied from recipe artifacts only; the docs script must not invent screenshots, posters, or videos.

## Proposed stage fixture layout

Use a dedicated artifact directory per capture run:

```text
.agent/demo-stage/docusaurus-command-center-parallel/
  input/
    fixture.json              # allowed project/run selection and capture route
    tasks/                    # generated demo task descriptors, if needed
  output/
    summary.json
    trace.json
    artifact-manifest.json
    screenshots/
    videos/
    posters/
  reset/
    before-state.json         # enough metadata to restore local state
```

If implementation lands elsewhere, keep the same concepts: input fixture, output artifacts, and reset metadata.

## First-stage fixture: Command Center parallel watch-and-steer

Purpose: generate the first Docusaurus video from real parallel Farmslot work.

Inputs:

- Farmslot issue #28 demo task.
- Audiolab issue #414 demo task if available.
- EchoBridge reversible demo task if available.
- Allowed-project filter: `farmslot`, `audiolab`, `echobridge`, `companion`, plus generic demo slot names.

Expected Command Center view:

- Multiple live terminals/worker panes or run-monitoring panels.
- Visible run status/progress.
- Visible demo badge from Farmslot issue #28 when enabled:
  `FARMSLOT DEMO: PARALLEL RUN MONITORING`
- No private project labels.

## Recipe responsibilities

The checked-in capture recipe must:

1. Apply the demo stage fixture or select an existing staged run family.
2. Launch Command Center.
3. Dispatch/select allowed demo runs.
4. Open the monitoring/workspace route chosen for capture.
5. Enable the demo badge only for the demo condition.
6. Assert multiple run/terminal panels are visible.
7. Assert forbidden text is absent.
8. Record an 8-15 second MP4 proof window.
9. Extract a poster frame from the MP4.
10. Capture at least one still screenshot.
11. Write `summary.json`, `trace.json`, and `artifact-manifest.json` with paths to all media.
12. Leave or document reset metadata.

## Next high-value Command Center captures

After the baseline watch-and-steer clip, prioritize these two product moments before adding more static app screenshots:

### Human ready/review gate

Purpose: show that Farmslot does not blindly trust an agent's final message. The operator lands on a completed ready/PR-review workspace, inspects the terminal/evidence/review state, and either accepts the PR or sends one more steering instruction.

Capture requirements:

1. Use an allowed demo run only: Farmslot issue #28, Audiolab #414, EchoBridge demo task, or sanitized fixture data.
2. Show the ready or PR-review decision area, not a fake final-status card.
3. Record only if the recipe performs a visible action such as opening the workspace, expanding evidence, and sending a follow-up steering prompt; otherwise use a screenshot.
4. Verify public safety with the same forbidden-text scan as the first video.
5. Emit `summary.json`, `trace.json`, and `artifact-manifest.json`.

Implemented command:

```bash
yarn --cwd apps/docs capture:human-ready-gate \
  --artifacts-dir .agent/demo-stage/docusaurus-human-ready-gate/output \
  --copy-to-docs
```

The current capture records the real Command Center ready-workspace surface with public-safe demo data, opens evidence/quality tabs, opens the extra-review modal, verifies forbidden labels are absent from the visible page, and copies only the inspected MP4/poster/screenshot into the docs site.

### Gateway intelligence from Command Center

Purpose: show Command Center as an intelligent gateway, not only a terminal multiplexer. The operator opens gateway intelligence and asks about fleet/runs, e.g. “which public demo slots are ready?” or “summarize active demo runs”.

Capture requirements:

1. Use the real Command Center route and gateway state. A sanitized demo profile/filter is allowed; a generated product screenshot is not.
2. The recipe must open gateway intelligence through the UI, type the question, submit it, and capture the answer.
3. The visible answer must not mention private projects, private paths,.
4. If live LLM-backed gateway intelligence is unavailable, capture the current UI affordance honestly and mark the demo as blocked rather than faking an answer.
5. Emit `summary.json`, `trace.json`, and `artifact-manifest.json`.

Implemented command:

```bash
yarn --cwd apps/docs capture:gateway-intelligence \
  --artifacts-dir .agent/demo-stage/docusaurus-gateway-intelligence/output \
  --copy-to-docs
```

The current capture records a real Command Center chat request against live gateway state, aliases allowed demo slots for public display, verifies forbidden labels are absent from the visible page, and copies only the inspected MP4/poster/screenshot into the docs site.

## Docs copy step

After visual inspection, copy only selected artifacts:

```text
recipe output/videos/command-center-parallel-watch.mp4
  -> apps/docs/static/videos/demos/command-center-parallel-watch.mp4
recipe output/posters/command-center-parallel-watch.png
  -> apps/docs/static/img/demos/command-center-parallel-watch.png
```

The copy script may validate file presence, dimensions, duration, and forbidden text metadata. It must not create synthetic visuals.

## Reset strategy

The stage fixture must be easy to remove:

- close demo-only worker sessions or release demo slots;
- remove generated demo task/run-family files if they were created only for capture;
- disable the demo badge condition;
- restore normal Command Center filters/profile;
- keep final Docusaurus media only if it passed public-safety review.

If reset cannot be automated in the first slice, document the manual reset commands in the recipe summary and this file before expanding to more videos.

## Implemented first-stage capture command

The first slice now uses:

```bash
yarn --cwd apps/docs capture:first-video \
  --artifacts-dir .agent/demo-stage/docusaurus-command-center-parallel/output \
  --copy-to-docs
```

The capture runner reuses an existing Chrome/CDP profile when available, disables notification prompts for new debug Chrome profiles, applies public-safe label sanitization, captures a pre-steer screenshot, records while sending safe terminal input, captures a post-steer screenshot, extracts a poster at the steering portion of the video, and copies only the inspected MP4/poster into `apps/docs/static/`.

The local `.agent/` directory is ignored and should remain local evidence, not committed media. Regenerate it from the recipe when UI changes.

## Implemented AudioLab app capture command

The AudioLab app slice now uses:

```bash
yarn --cwd apps/docs capture:audiolab-demo \
  --artifacts-dir .agent/demo-stage/docusaurus-audiolab-sample-banner/output \
  --copy-to-docs
```

The capture runner reads `projects/audiolab-farm/project.json` and the playground app `.env.development`, launches the real playground app on the configured iOS simulator/Metro port, applies the reversible issue #414 demo banner fixture locally, drives the Import screen through the app CDP bridge, records the iOS simulator while pressing `load-sample-button`, verifies the exact banner text, writes `summary.json`, `trace.json`, and `artifact-manifest.json`, copies only inspected media into `apps/docs/static/`, then restores the AudioLab source file.
