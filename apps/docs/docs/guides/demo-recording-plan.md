---
title: Demo recording plan
description: Public-safe recording specs and storyboards for Farmslot landing page demos.
---

# Demo recording plan

The landing page now uses recipe-backed public-safe poster frames from `apps/docs/static/img/demos/`. They are generated from checked-in Farmslot recipe fixtures or from the demo media generation script. Final short clips should be added later under `apps/docs/static/videos/demos/` and wired back into the same cards after sanitization. Keep detailed narration drafts outside the public docs until they become stable product-facing copy.

Current poster frames represent real Farmslot surfaces:

- **Command Center supervised run**: Command Center ready/review recipe workspace fixture.
- **Recipe evidence run**: live recipe player fixture with stream, logs, and typed artifacts.
- **Project-type framework**: Audiolab + EchoBridge public demo integration poster.
- **Companion mobile supervision**: mobile companion recipe evidence fixture.

## Reproduce current poster frames

Regenerate committed poster frames from repository fixtures:

```bash
yarn --cwd apps/docs generate:demos
```

| Landing card                  | Committed asset                                                  | Provenance                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Command Center supervised run | `apps/docs/static/img/demos/command-center-recipe-workspace.svg` | `docs/examples/recipes/farmslot/command-center-ui.recipe.json` plus its checked-in artifact package.              |
| Recipe evidence run           | `apps/docs/static/img/demos/recipe-evidence-run.svg`             | `docs/examples/recipes/farmslot/recipe-player-e2e.recipe.json` plus its checked-in artifact package.              |
| Project-type framework        | `apps/docs/static/img/demos/project-type-framework.svg`          | `apps/docs/scripts/generate-demo-media.mjs`, summarizing approved Audiolab and EchoBridge Recipe v1 integrations. |
| Companion mobile supervision  | `apps/docs/static/img/demos/mobile-companion-artifacts.svg`      | `docs/examples/recipes/farmslot/mobile-companion.recipe.json` plus its checked-in artifact package.               |

Reset path: delete `apps/docs/static/img/demos/*`, rerun `yarn --cwd apps/docs generate:demos`, and discard any unrelated local recipe-run output under project `.agent/` directories.

## Validate project-type poster claims

The project-type framework poster is a summary card, so validate it against the public demo project recipes before recording or publishing a replacement clip.

Audiolab:

```bash
cd <audiolab-checkout>/apps/playground
IOS_SIMULATOR=playground-1 WATCHER_PORT=7365 yarn ios
WATCHER_PORT=7365 node scripts/agentic/recipe-v1/run-recipe-v1.mjs run \
  scripts/agentic/recipe-v1/recipes/smoke.navigation.recipe.json \
  --artifacts-dir /tmp/audiolab-recipe-smoke \
  --device playground-1
```

EchoBridge:

```bash
cd <echobridge-checkout>/apps/echobridge
IOS_SIMULATOR=echodev-1 yarn ios
node scripts/agentic/recipe-v1/run-recipe-v1.mjs validate \
  scripts/agentic/recipe-v1/recipes/smoke.navigation.recipe.json
node scripts/agentic/recipe-v1/run-recipe-v1.mjs validate \
  scripts/agentic/recipe-v1/recipes/recording.sync.lifecycle.recipe.json
node scripts/agentic/recipe-v1/run-recipe-v1.mjs run \
  scripts/agentic/recipe-v1/recipes/recording.sync.lifecycle.recipe.json \
  --artifacts-dir /tmp/echobridge-recipe-sync \
  --device web
```

Use the project-configured simulator names. The current EchoBridge iOS simulator is `echodev-1`; do not rename it for docs capture.

## Public-safety checklist

Before committing a screenshot or video, verify that it contains none of the following:

- real private repository names, customer names, Jira IDs, tokens, secrets, wallet addresses, or API keys;
- real machine names, private hostnames, local absolute paths, or home-directory usernames;
- private chat, email, browser history, or notification content;
- proprietary product details that are not intended for public docs;
- private work project names or screenshots until cleared for public use.

Prefer demo projects, fixture data, Audiolab, EchoBridge, and generic labels such as “example app”, “demo slot”, and “recipe evidence”. Re-record instead of blurring if private data appears.

## Recommended format

| Asset        | Recommendation                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Duration     | 4–15 seconds for committed clips; longer demos should be hosted externally.                    |
| Aspect ratio | 16:9 for Command Center; 9:16 is acceptable for Companion.                                     |
| Resolution   | 1080p maximum unless the clip needs more detail.                                               |
| Poster       | Extract a real frame from the video and inspect it before publishing.                          |
| Captions     | Nearby page text must explain the clip because videos are muted by default.                    |
| File size    | Keep committed clips small; use external hosting for large videos.                             |
| Naming       | `command-center-run`, `recipe-evidence-run`, `project-type-framework`, `mobile-companion-run`. |

## Storyboards

Prefer one narrated clip per product promise. The key phrase is **watch and steer**: demos should show the human guiding the agent while work is happening, not merely watching a final report.

### 1. Command Center supervised run

Show the operator following work through the control plane.

1. Start from the sanitized flow graph or run-control fixture.
2. Show the orchestration path: find slot, dispatch, monitor, review, feedback, publish gate.
3. Show a human decision or review state.
4. End with the controlled completion path.

### 2. Recipe evidence run

Show how a recipe turns acceptance criteria into proof.

1. Start from a recipe graph with setup, validate, and teardown lanes.
2. Show action and assertion nodes.
3. Show recipe-run provenance or selected evidence.
4. End on a reviewable artifact state.

### 3. Project-type framework

Show that Farmslot is not one-app-specific.

1. Show Audiolab and EchoBridge as approved public demo targets.
2. Show each project exposing hooks/capabilities through Recipe v1.
3. End on the shared artifact package shape.

### 4. Companion mobile supervision

Show that supervision does not require sitting at the workstation.

1. Open the mobile companion on a sanitized fixture profile.
2. Show active run status.
3. Navigate to fleet or terminal status.
4. Keep private gateway settings and machine-specific profiles out of frame.

## Capture commands for future clips

When final videos are ready, capture Command Center clips from the real dev harness served on port `5174`, encode with `ffmpeg`, and extract poster frames from the MP4 files.

Companion was captured from an installed iOS development build with store-screenshot fixtures enabled:

```bash
# Terminal 1: sanitized Companion fixture bundle
cd apps/companion
env APP_VARIANT=development \
  BUNDLE_ID=<your-dev-bundle-id> \
  METRO_PORT=7688 RCT_METRO_PORT=7688 \
  EXPO_PUBLIC_STORE_SCREENSHOTS=1 \
  EXPO_PUBLIC_GATEWAY_URL= \
  yarn expo start --dev-client --port 7688 --host lan --scheme farmslot-development

# Terminal 2: launch the real iOS app against that bundle
xcrun simctl openurl <ios-simulator> \
  '<dev-client-scheme>://expo-development-client/?url=http%3A%2F%2F<lan-ip>%3A7688'
```

Then record with `xcrun simctl io <ios-simulator> recordVideo`, drive deep links such as `farmslot-development://runs`, and extract a poster frame with `ffmpeg -frames:v 1`.

## Validation checklist

- Regenerate posters with `yarn --cwd apps/docs generate:demos`.
- Build the docs site with `yarn docs:build`.
- Serve the site locally and verify the landing page poster frames render.
- When final clips are added, verify the landing page videos render.
- Extract at least one frame from every committed MP4 and inspect it visually.
- Verify Companion fixture mode on a real simulator/device when the mobile clip changes.
- Keep raw capture files in `/tmp`; only commit compressed MP4s and poster frames.
