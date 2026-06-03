---
title: Demo recording plan
description: Public-safe recording specs and storyboards for Farmslot landing page demos.
---

# Demo recording plan

The landing page currently uses static, public-safe generated SVG mockups from `apps/docs/static/img/mockups/` so the project can be released before the final narrated videos are recorded. Final clips should be added later under `apps/docs/static/videos/` and wired back into the landing page after sanitization. Keep detailed narration drafts outside the public docs until they become stable product-facing copy.

Current placeholders represent real Farmslot surfaces:

- **Command Center supervised run**: Command Center dev harness with sanitized fixtures.
- **Recipe evidence run**: Command Center recipe graph and provenance fixtures.
- **Companion mobile supervision**: the iOS Companion app running in store-screenshot fixture mode.

## Public-safety checklist

Before committing a screenshot or video, verify that it contains none of the following:

- real private repository names, customer names, Jira IDs, tokens, secrets, wallet addresses, or API keys;
- real machine names, private hostnames, local absolute paths, or home-directory usernames;
- private chat, email, browser history, or notification content;
- proprietary product details that are not intended for public docs.

Prefer demo projects, fixture data, and generic labels such as “example app”, “demo slot”, and “recipe evidence”. Re-record instead of blurring if private data appears.

## Recommended format

| Asset        | Recommendation                                                              |
| ------------ | --------------------------------------------------------------------------- |
| Duration     | 4–15 seconds for committed clips; longer demos should be hosted externally. |
| Aspect ratio | 16:9 for Command Center; 9:16 is acceptable for Companion.                  |
| Resolution   | 1080p maximum unless the clip needs more detail.                            |
| Poster       | Extract a real frame from the video and inspect it before publishing.       |
| Captions     | Nearby page text must explain the clip because videos are muted by default. |
| File size    | Keep committed clips small; use external hosting for large videos.          |
| Naming       | `command-center-run`, `recipe-evidence-run`, `mobile-companion-run`.        |

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

### 3. Companion mobile supervision

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

- Build the docs site with `yarn docs:build`.
- Serve the site locally and verify the landing page placeholders render.
- When final clips are added, verify the landing page videos render.
- Extract at least one frame from every committed MP4 and inspect it visually.
- Verify Companion fixture mode on a real simulator/device when the mobile clip changes.
- Keep raw capture files in `/tmp`; only commit compressed MP4s and poster frames.
