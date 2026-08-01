---
title: Expo Recipe integration
---

# Expo Recipe integration

`@farmslot/expo-recipe` is the convenience Expo/React Native package on top of `@farmslot/recipe-harness`. It does not define a separate protocol or custom base actions; it scaffolds an Expo app so it can use the same Recipe Protocol v1 and official harness actions as other Farmslot-compatible projects. The Companion app in this repository is the canonical Expo example.

For backend, CLI, library, or other non-UI projects, start with the
[Headless Recipe integration](./headless-recipe.md) guide instead.

The generated files use **Recipe Protocol v1**, but paths and package scripts are intentionally versionless:

```text
scripts/agentic/recipe/
yarn recipe:doctor
yarn recipe:validate
yarn recipe:dry-run
yarn recipe:run
```

That keeps app code stable when the protocol evolves.

## How it composes with Farmslot

- `@farmslot/protocol` defines Recipe Protocol v1 schemas, official action names, and artifact contracts.
- `@farmslot/recipe-harness` implements the generic runner, official core/UI actions, and CDP/React Native transport helpers.
- `@farmslot/expo-recipe` wraps those pieces for Expo projects by installing scripts, a default manifest/recipe, and optional dev-only bridge/HUD components.

That means Expo projects should not reimplement generic actions like `ui.press`, `ui.set_input`, `ui.scroll`, `app.hud`, or `app.status`. Add only project/domain actions in the app-specific layer when the official actions are not enough.

## Install into an Expo app

```bash
yarn add -D @farmslot/expo-recipe @farmslot/recipe-harness @farmslot/protocol
farmslot-expo-recipe init
yarn recipe:doctor
```

The package manager resolves the current published versions. Do not use the Yarn workspace protocol outside the Farmslot monorepo; it only works for local workspace packages.

## Default mode: headless and safe

The default scaffold declares only actions it can execute immediately:

- `command`
- `assert_output`
- `wait`
- `end`

This is enough to prove the runner, recipe validation, and artifact package without requiring app changes.

```bash
yarn recipe:validate
yarn recipe:dry-run
yarn recipe:run
```

`recipe:dry-run` still runs core/headless commands; it only stubs live UI, CDP,
and app bridge actions. Command output is sanitized before recipe artifacts are
written so public Expo config secrets do not leak into `trace.json`.

Recipes that execute Metro-backed actions such as `app.status`, `app.hud`, or
`app.trace` must set `FARMSLOT_RECIPE_METRO_PORT` or `METRO_PORT` to the
assigned port (1–65535). `FARMSLOT_RECIPE_METRO_PORT` takes precedence. There
is no default port or `WATCHER_PORT` fallback. The port is resolved only when a
Metro-backed action runs, so headless and native-only recipes do not need it.

When asserting command output that may be redacted, prefer stable substrings or structured fields over exact pretty-printed JSON whitespace.

## Optional dev-only bridge and HUD

If a project wants in-app status or a human-readable HUD, install the bridge scaffold:

```bash
farmslot-expo-recipe init --with-bridge
```

Then wrap the app root:

```tsx
import { RecipeBridgeProvider } from './src/farmslot';

export default function App() {
  return <RecipeBridgeProvider>{/* app */}</RecipeBridgeProvider>;
}
```

The generated provider is guarded by both:

- `__DEV__`
- `EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1`

The bridge and HUD are copied into local source files by design, so each app can customize `bridgeName`, bridge enablement, or HUD rendering without forking `@farmslot/recipe-harness`. Farmslot Companion uses this path as the in-repo Expo example: it keeps the generated `src/farmslot/` bridge local and wraps the root layout with `RecipeBridgeProvider`.

The HUD contract is deliberately strict: one concise intent line for the human from the current recipe node. Avoid repeating action names, node IDs, or debug noise in the visible text.

Run `yarn recipe:doctor` after enabling bridge actions. The doctor fails if the manifest declares app/HUD actions but the bridge provider is missing or not dev-gated.

## Farmslot hook

Expose the runner through a thin project hook:

```json
{
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}} --platform {{platform}} --metro-port {{port}}"
  }
}
```

The reusable behavior belongs in `@farmslot/expo-recipe`. Project-specific behavior belongs in small domain manifests and bridge actions owned by that project.

## Quality rules

- Keep manifests small and discoverable.
- Prefer one parameterized custom action over many near-duplicates.
- Never add task-specific or ticket-specific actions to reusable manifests.
- Use official UI actions only when the proof should show real user-visible interaction.
- Use commands/controllers for setup, diagnostics, or non-visual checks.
- Fail closed when live bridge support is unavailable.
