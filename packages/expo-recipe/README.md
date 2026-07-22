# @farmslot/expo-recipe

Convenience Expo/React Native integration package built on top of `@farmslot/recipe-harness`. It does not define a second protocol or runner; it scaffolds an Expo project so it can use the same Recipe Protocol v1 and official harness actions as other Farmslot projects.

Public docs: <https://farmslot.io/docs/guides/expo-recipe>

## Source layout

| Path               | Owns                                                          |
| ------------------ | ------------------------------------------------------------- |
| `bin/`             | Published `farmslot-expo-recipe` executable shim.             |
| `src/cli.ts`       | Init command parsing and CLI entrypoint.                      |
| `src/scaffold.ts`  | File-copy and package-script scaffolding.                     |
| `src/doctor.ts`    | Project integration checks.                                   |
| `src/runner.ts`    | Expo smoke runner wiring built on `@farmslot/recipe-harness`. |
| `src/redaction.ts` | Output redaction helpers for generated artifacts.             |
| `templates/`       | Versionless project scaffold copied into consuming Expo apps. |

## Relationship to the harness

`@farmslot/expo-recipe` is a thin integration layer:

- `@farmslot/protocol` owns Recipe Protocol v1 schemas, action names, and validation.
- `@farmslot/recipe-harness` owns the generic runner, official core actions, UI actions, and CDP/React Native transports.
- `@farmslot/expo-recipe` only adds Expo-friendly scaffolding: package scripts, a default recipe, optional dev-only React Native bridge/HUD files, and integration checks.

Do not add project-specific actions such as wallet, perps, or meetings to this package. Those belong in the app or a project-specific runner/manifest that extends the official harness actions. Generic whole-run video proof stays in the shared harness capability surface.

## What it installs

- a versionless `scripts/agentic/recipe/` scaffold;
- a small headless action manifest using official harness actions;
- an Expo config smoke recipe that emits the standard Farmslot artifact package;
- `recipe:*` package scripts;
- optional dev-only bridge/HUD files when `--with-bridge` is requested.

Protocol versioning remains inside recipe metadata. User-facing paths and scripts stay versionless.

## Usage

```bash
# Published package path, once @farmslot packages are public.
yarn add -D @farmslot/expo-recipe @farmslot/recipe-harness @farmslot/protocol
farmslot-expo-recipe init
yarn recipe:doctor
yarn recipe:validate
yarn recipe:dry-run
yarn recipe:run
```

Pass typed values with `--param key=value`. A task recipe at `artifacts/recipe.json` can keep task-only dependencies in `artifacts/recipe-library/`; the runner discovers them automatically.

`recipe:dry-run` still runs core/headless commands; it only stubs live UI, CDP,
and app bridge actions. Command output is sanitized before recipe artifacts are
written so public Expo config secrets do not leak into `trace.json`.

When asserting command output that may be redacted, prefer stable substrings or structured fields over exact pretty-printed JSON whitespace.

For motion-sensitive visual proof, `farmslot-expo-recipe run --record-video`
records one whole-recipe MP4 through `capture-helper`. By default it targets the
macOS Simulator window; override with `--record-pid`, `--record-window-id`, or
`--record-app-name` plus `--record-window-name`.

For a UI/HUD-capable app scaffold:

```bash
farmslot-expo-recipe init --with-bridge
```

Then wrap the app root with `RecipeBridgeProvider` and enable it only in development:

```tsx
import { RecipeBridgeProvider } from './src/farmslot';

export default function App() {
  return <RecipeBridgeProvider>{/* app */}</RecipeBridgeProvider>;
}
```

The generated bridge no-ops unless both conditions are true:

- `__DEV__`
- `EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1`

The bridge and HUD are copied into local source files by design, so each app can customize `bridgeName`, bridge enablement, HUD text, HUD styles, or full HUD rendering without forking the harness.

Default HUD text is compact and wraps instead of ellipsizing. To tune the generated HUD without replacing it:

```tsx
<RecipeBridgeProvider
  hud={{
    text: {
      badge: (state) => `${state.status} ${state.currentStep ?? ''}/${state.totalSteps ?? ''}`,
      intent: (state) => state.intent,
      error: (state) => state.error,
    },
    styles: {
      container: { bottom: 24, backgroundColor: 'rgba(0, 0, 0, 0.7)' },
      line: { fontSize: 10, lineHeight: 13 },
      intent: { color: '#fff' },
    },
  }}
>
  {/* app */}
</RecipeBridgeProvider>
```

For a completely custom overlay, pass `renderHud`.

## Maintenance rules

1. **Stay thin.** Keep this package to Expo scaffolding and checks; generic execution belongs in `@farmslot/recipe-harness`.
2. **Keep manifests small and project-supported.** Do not add task-specific or ticket-specific actions.
3. **Parameterize before multiplying.** Prefer one parameterized domain action over duplicate narrow actions.
4. **Use UI/HUD actions only for visible proof.** Preparation and fixture convergence should stay separate from the measured proof nodes.
5. **Keep templates versionless.** Protocol versioning belongs in recipe metadata, not in generated path names.
6. **Run `yarn recipe:doctor` before handing a scaffolded project to Farmslot.**

## Local quality

```bash
yarn workspace @farmslot/expo-recipe quality
```

## License

MIT. See [LICENSE](LICENSE).
