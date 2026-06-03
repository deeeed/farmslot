---
title: Expo / React Native project integration
---

# Expo / React Native project integration

Expo and React Native projects are a strong fit for Farmslot because they often
need cross-platform proof: iOS, Android, web, device logs, screenshots, videos,
and reviewer-readable UI traces.

This guide describes lightweight Farmslot support for an Expo app. It does not
assume organization-specific bundle IDs, store deployment, custom icons, or
private device conventions.

## What this guide gives you

After the minimal integration, your Expo app should be able to:

- run a Farmslot recipe through a project hook;
- delegate actual behavior to your existing Expo/dev-client/test scripts;
- emit `summary.json`, `trace.json`, and `artifact-manifest.json`;
- attach screenshots, videos, logs, or structured reports when available;
- optionally expose UI actions and a proof HUD/overlay.

## Minimal file layout

One simple layout:

```text
your-expo-app/
  scripts/
    agentic/
      validate-recipe.sh
      action-manifest.json        # optional at first, recommended for UI actions
      recipes/
        smoke.recipe.json
```

Farmslot project config:

```json
{
  "name": "my-expo-app",
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  },
  "recipe_run_supports_playback_slow": false
}
```

Set `recipe_run_supports_playback_slow` to `true` only when your runner actually
supports slowed live playback.

## Minimal recipe

Start with a command-backed recipe. It can call your existing checks before you
add device/UI automation.

```json
{
  "schema_version": 1,
  "title": "Expo app smoke check",
  "description": "Runs the app's existing smoke validation and publishes logs.",
  "validate": {
    "workflow": {
      "entry": "run-smoke",
      "nodes": {
        "run-smoke": {
          "action": "command",
          "cmd": "yarn typecheck",
          "next": "done"
        },
        "done": {
          "action": "end",
          "status": "pass"
        }
      },
      "playback": {
        "mode": "off",
        "slow_ms": 2000
      }
    }
  }
}
```

## Minimal runner skeleton

The runner can be a thin wrapper around your existing scripts. It should always
write the artifact package to the `--artifacts-dir` provided by Farmslot.

```bash
#!/usr/bin/env bash
set -euo pipefail

RECIPE=""
ARTIFACTS_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recipe)
      RECIPE="$2"
      shift 2
      ;;
    --artifacts-dir)
      ARTIFACTS_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RECIPE" || -z "$ARTIFACTS_DIR" ]]; then
  echo "Usage: validate-recipe.sh --recipe <recipe.json> --artifacts-dir <dir>" >&2
  exit 2
fi

mkdir -p "$ARTIFACTS_DIR/logs"
cp "$RECIPE" "$ARTIFACTS_DIR/recipe.json"

START_MS="$(node -e 'console.log(Date.now())')"
set +e
yarn typecheck >"$ARTIFACTS_DIR/logs/typecheck.log" 2>&1
STATUS=$?
set -e
END_MS="$(node -e 'console.log(Date.now())')"

node >"$ARTIFACTS_DIR/summary.json" <<JSON
{
  "status": "$([[ "$STATUS" -eq 0 ]] && echo pass || echo fail)",
  "startedAtMs": $START_MS,
  "endedAtMs": $END_MS,
  "error": $([[ "$STATUS" -eq 0 ]] && echo null || echo '"typecheck failed"')
}
JSON

node >"$ARTIFACTS_DIR/trace.json" <<JSON
[
  {
    "nodeId": "run-smoke",
    "action": "command",
    "status": "$([[ "$STATUS" -eq 0 ]] && echo pass || echo fail)",
    "artifacts": ["logs/typecheck.log"]
  }
]
JSON

node >"$ARTIFACTS_DIR/artifact-manifest.json" <<JSON
{
  "version": 1,
  "runStatus": "$([[ "$STATUS" -eq 0 ]] && echo pass || echo fail)",
  "artifacts": [
    {
      "path": "logs/typecheck.log",
      "type": "log",
      "label": "TypeScript check log",
      "nodeId": "run-smoke",
      "mimeType": "text/plain"
    }
  ]
}
JSON

exit "$STATUS"
```

This is intentionally small. Replace `yarn typecheck` with your existing smoke
script, Detox/Maestro/Playwright flow, Expo dev-client launch, or device test as
the project matures.

## UI/device actions

Once the command-backed recipe is useful, add project-specific UI actions through
an action manifest. Keep the action names stable and reviewer-readable.

Example action manifest fragment:

```json
{
  "version": 1,
  "actions": [
    {
      "name": "ui.navigate",
      "description": "Navigate to an app route or screen",
      "capabilities": ["ui", "react-native"]
    },
    {
      "name": "ui.screenshot",
      "description": "Capture a screenshot artifact",
      "capabilities": ["ui", "evidence"]
    },
    {
      "name": "app.hud",
      "description": "Show reviewer-facing proof context if supported",
      "capabilities": ["ui", "hud"],
      "optional": true
    }
  ]
}
```

Project actions may wrap:

- Expo dev-client launch;
- Detox or Maestro;
- Playwright for Expo web;
- React Native debug/bridge commands;
- simulator/device screenshots;
- native logs.

## HUD / overlay guidance

HUD support is optional. If you add it, it must be a reviewer aid only:

- show human intent, phase, node id, and proof target;
- never mutate product state;
- never hide the UI state being proved;
- emit normal screenshots/videos/logs through `artifact-manifest.json`;
- make unsupported HUD behavior explicit instead of silently pretending it works.

## New-project prompt

Use this prompt when starting a new Expo project:

```text
Create a new Expo / React Native app with lightweight Farmslot support.

Do not assume organization-specific bundle IDs, store deployment, custom icon
generation, or private device names.

Please scaffold or describe:
1. the minimal Farmslot project hook;
2. scripts/agentic/validate-recipe.sh;
3. one schema_version: 1 smoke recipe;
4. summary.json, trace.json, and artifact-manifest.json output;
5. optional action-manifest.json for future UI actions;
6. optional HUD capability as unsupported/no-op unless implemented;
7. validation commands to prove the recipe artifact package is well formed.
```

## Existing-project prompt

Use this prompt when integrating an existing Expo project:

```text
Audit this existing Expo / React Native project for lightweight Farmslot support.

Do not change app identity, release profiles, app icons, device scripts, or release
automation unless explicitly requested.

Produce:
1. current app/test/script summary;
2. the smallest useful Farmslot recipe proof;
3. a project.json recipe_run hook;
4. a validate-recipe.sh wrapper around existing scripts;
5. expected summary.json, trace.json, artifact-manifest.json outputs;
6. optional UI/action-manifest/HUD follow-ups;
7. a safe first PR plan.
```

## When to add more

Add more automation only after the first recipe package is useful in review.
Good next additions are:

- a screenshot artifact;
- a video/proof window for a UI acceptance criterion;
- an action manifest;
- slow playback support;
- before/after visual comparison;
- device matrix recipes for iOS and Android.

Keep deployment, store release, and opinionated variant branding separate unless
the project explicitly wants those conventions.
