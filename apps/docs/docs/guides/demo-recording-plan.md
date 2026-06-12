---
title: Demo recording plan
description: Public-safe recording specs and regeneration commands for Farmslot landing page demos.
---

# Demo recording plan

The landing page uses checked-in, recipe-produced demo media:

| Landing asset                            | Committed files                                                                                                                                                                                                                    | Regeneration command                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command Center parallel watch-and-steer  | `apps/docs/static/videos/demos/command-center-parallel-watch.mp4`<br />`apps/docs/static/img/demos/command-center-parallel-watch.png`                                                                                              | `yarn --cwd apps/docs capture:first-video --artifacts-dir .agent/demo-stage/docusaurus-command-center-parallel/output --copy-to-docs`                                                                           |
| Gateway intelligence from Command Center | `apps/docs/static/videos/demos/command-center-gateway-intelligence.mp4`<br />`apps/docs/static/img/demos/command-center-gateway-intelligence.png`<br />`apps/docs/static/img/demos/command-center-gateway-intelligence-answer.png` | `yarn --cwd apps/docs capture:gateway-intelligence --artifacts-dir .agent/demo-stage/docusaurus-gateway-intelligence/output --copy-to-docs`                                                                     |
| Human ready gate                         | `apps/docs/static/img/demos/command-center-human-ready-gate.png`                                                                                                                                                                   | `yarn --cwd apps/docs capture:human-ready-gate --artifacts-dir .agent/demo-stage/docusaurus-human-ready-gate/output --copy-to-docs`                                                                             |
| Recipe evidence validation loop          | `apps/docs/static/img/demos/recipe-evidence-validation-loop.png`                                                                                                                                                                   | `yarn --cwd apps/docs capture:recipe-evidence --artifacts-dir .agent/demo-stage/docusaurus-recipe-evidence-loop/output --source-dir .agent/demo-stage/docusaurus-command-center-parallel/output --copy-to-docs` |
| Companion mobile supervision             | `apps/docs/static/img/demos/companion-mobile-supervision.png`                                                                                                                                                                      | `yarn --cwd apps/docs capture:companion-supervision --artifacts-dir .agent/demo-stage/docusaurus-companion-supervision/output --copy-to-docs`                                                                   |
| Project-type validation matrix           | `apps/docs/static/img/demos/project-type-validation-matrix.svg`                                                                                                                                                                    | `yarn --cwd apps/docs capture:project-type-matrix --artifacts-dir .agent/demo-stage/docusaurus-project-type-validation-matrix/output --copy-to-docs`                                                            |

The Companion supervision card is captured from the real Companion development app on the configured `fs-companion-1` simulator against a public-safe fixture gateway. It does **not** regenerate store screenshots and must not use `apps/companion/scripts/screenshots/capture-store-screenshots.sh`.

The project-type validation matrix is a clearly labeled architecture/schema diagram, not a product screenshot. Raw external app screenshots must appear only as evidence artifacts inside Command Center or Companion surfaces, not as standalone landing cards.

The Command Center capture recipe opens real Command Center, applies a public-safe filter, verifies multiple terminal panes, records while sending visible steering input, and writes proof artifacts. The docs media then burns in a visible Recipe runner HUD overlay with `yarn --cwd apps/docs overlay:runner-hud` so the public clip shows the runner/proof layer, not just a dashboard.

- `.agent/demo-stage/docusaurus-command-center-parallel/output/summary.json`
- `.agent/demo-stage/docusaurus-command-center-parallel/output/trace.json`
- `.agent/demo-stage/docusaurus-command-center-parallel/output/artifact-manifest.json`

## Public-safety checklist

Before copying a screenshot or video into `apps/docs/static/`, visually inspect it and confirm it contains none of:

- uncleared work project names, private farm aliases, or private repository names;
- tokens, secrets, financial/account identifiers, customer/Jira data, notifications, private chats, browser history;
- private absolute paths or local usernames;
- private repository screens that are not explicitly approved for public docs.

Use approved public demo targets only: Farmslot self-demo, Audiolab, EchoBridge, Companion, or generic demo labels.

## First video recipe

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-command-center-parallel-watch.recipe.json
```

Run it from the repository root:

```bash
yarn --cwd apps/docs capture:first-video \
  --artifacts-dir .agent/demo-stage/docusaurus-command-center-parallel/output \
  --copy-to-docs
```

The capture script reuses an existing debug Chrome on `FARMSLOT_DEMO_CDP_PORT` when available, otherwise launches the dedicated profile with notifications disabled. During the MP4 recording it sends safe demo commands into the visible terminal panes so the clip demonstrates watch-and-steer, not just a static dashboard.

Useful overrides:

```bash
FARMSLOT_DEMO_CDP_PORT=9324 \
FARMSLOT_DEMO_CAPTURE_SECONDS=12 \
yarn --cwd apps/docs capture:first-video \
  --artifacts-dir .agent/demo-stage/docusaurus-command-center-parallel/output \
  --copy-to-docs
```

## Companion mobile supervision screenshot

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-companion-supervision.recipe.json
```

Regenerate the real Companion simulator capture and docs copy:

```bash
yarn --cwd apps/docs capture:companion-supervision \
  --artifacts-dir .agent/demo-stage/docusaurus-companion-supervision/output \
  --copy-to-docs
```

This command launches the real Companion development build on the configured simulator, points it at a LAN-reachable public-safe fixture gateway, verifies real `fleet.status` and `run.list` websocket requests, records a simulator MP4/poster/final screenshot, and writes `summary.json`, `trace.json`, and `artifact-manifest.json`. It pre-approves notifications/camera/microphone permissions and suppresses the dev-menu onboarding/floating button for clean public media. It must not regenerate Companion store screenshots.

## Project-type validation matrix

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-project-type-validation-matrix.recipe.json
```

Regenerate the labeled schema diagram from the repository root:

```bash
yarn --cwd apps/docs capture:project-type-matrix \
  --artifacts-dir .agent/demo-stage/docusaurus-project-type-validation-matrix/output \
  --copy-to-docs
```

This is intentionally a generated SVG diagram. It backs the project-type framework claim without pretending to be a product screenshot. AudioLab and EchoBridge evidence remains in recipe artifact packages until a Farmslot UI surface embeds it as review/ready-gate evidence.

## Recipe evidence screenshot

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-recipe-evidence-loop.recipe.json
```

Run it after the Command Center capture exists:

```bash
yarn --cwd apps/docs capture:recipe-evidence \
  --artifacts-dir .agent/demo-stage/docusaurus-recipe-evidence-loop/output \
  --source-dir .agent/demo-stage/docusaurus-command-center-parallel/output \
  --copy-to-docs
```

This capture reads the real `summary.json`, `trace.json`, `artifact-manifest.json`, and `recipe.json` from the Command Center capture output, renders a public-safe evidence board, verifies required artifact labels, and screenshots it. It is intentionally a screenshot, not a video, because the evidence package is static data.

## Gateway intelligence from Command Center video

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-gateway-intelligence.recipe.json
```

Run it from the repository root:

```bash
yarn --cwd apps/docs capture:gateway-intelligence \
  --artifacts-dir .agent/demo-stage/docusaurus-gateway-intelligence/output \
  --copy-to-docs
```

This capture opens Command Center with public demo project filters, opens the intelligence drawer through Cmd+K, types a public-safe fleet-status question, waits for the live gateway answer, scans the visible page for forbidden labels, records an MP4, extracts a poster, and captures a final screenshot of the answer.

## Human ready gate screenshot

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-human-ready-gate.recipe.json
```

Regenerate the Command Center ready-gate screenshot:

```bash
yarn --cwd apps/docs capture:human-ready-gate \
  --artifacts-dir .agent/demo-stage/docusaurus-human-ready-gate/output \
  --copy-to-docs
```

This capture starts a public-safe fixture gateway, opens the real Command Center UI at the slot ready workspace, verifies the human gate actions (`Approve Publish`, `Extra Review`), package evidence, recipe, quality, and diff tabs are visible, scans the rendered page for forbidden labels, and writes `summary.json`, `trace.json`, and `artifact-manifest.json`. It is a screenshot rather than a video because the gate is a review decision surface; motion should be recorded only when manually steering or approving the gate.

## Backing app evidence captures

AudioLab and EchoBridge app captures are backing evidence for the project-type framework claim. They are not standalone landing demos. If used publicly, show them inside a Command Center ready/review gate or Companion artifact/evidence surface.

Recipe metadata:

```text
docs/examples/recipes/farmslot/docusaurus-audiolab-sample-banner.recipe.json
docs/examples/recipes/farmslot/docusaurus-echobridge-live-recording.recipe.json
```

Regenerate local evidence packages from the repository root:

```bash
yarn --cwd apps/docs capture:audiolab-demo \
  --artifacts-dir .agent/demo-stage/docusaurus-audiolab-sample-banner/output

yarn --cwd apps/docs capture:echobridge-demo \
  --artifacts-dir .agent/demo-stage/docusaurus-echobridge-live-recording/output
```

Only copy selected app media into `apps/docs/static/` when a Farmslot UI demo embeds that media as an artifact in Command Center or Companion.

Current validated backing packages:

- AudioLab: `.agent/demo-stage/docusaurus-audiolab-sample-banner/output/summary.json` (`playground-1`, `WATCHER_PORT=7365`). The capture drives the real Import screen, presses `load-sample-button`, verifies `FARMSLOT DEMO: SAMPLE AUDIO LOADED`, records the configured simulator with `xcrun simctl io`, extracts the poster from the MP4, and restores the temporary fixture.
- EchoBridge: `.agent/demo-stage/docusaurus-echobridge-live-recording/output/summary.json` (`echodev-1`, `WATCHER_PORT=7600`). The capture installs only the local public-safe auth fixture, starts a real recorder session, verifies `isRecording=true`, records the configured simulator with `xcrun simctl io`, extracts the poster from the MP4, captures the final screenshot, and stops the recorder.

## Validation checklist

- Run the capture command above.
- Run `yarn --cwd apps/docs overlay:runner-hud` after regenerating Command Center videos.
- Inspect the produced MP4 and poster frame visually; Command Center clips must show the Recipe runner HUD, and Companion screenshots must show real run/evidence supervision rather than a fallback/store mock.
- Confirm each capture output has `summary.json`, `trace.json`, and `artifact-manifest.json` referencing the produced media.
- Build the docs site with `yarn docs:build`.
- Serve/open Docusaurus locally and verify the landing hero video and demo section render.
- Do not add more landing videos until the first clip passes this loop.
