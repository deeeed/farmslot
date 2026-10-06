# @farmslot/adapter-rn

Convenience Expo/React Native integration package built on top of `@farmslot/recipe-runner`. It does not define a second protocol or runner; it scaffolds an Expo project so it can use the same Recipe Protocol v1 and official harness actions as other Farmslot projects.

Public docs: <https://farmslot.io/docs/guides/adapter-rn>

## Source layout

| Path                                                                         | Owns                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bin/`                                                                       | Published `farmslot-adapter-rn` executable shim.                                                 |
| `src/cli.ts`                                                                 | Init command parsing and CLI entrypoint.                                                         |
| `src/scaffold.ts`                                                            | File-copy and package-script scaffolding.                                                        |
| `src/doctor.ts`                                                              | Project integration checks.                                                                      |
| `src/runner.ts`                                                              | Expo smoke runner wiring built on `@farmslot/recipe-runner`.                                     |
| `src/redaction.ts`                                                           | Output redaction helpers for generated artifacts.                                                |
| `templates/`                                                                 | Versionless project scaffold copied into consuming Expo apps.                                    |
| `bridge-runtime/`                                                            | Hermes CDP bridge libraries (`lib/*.cjs`) and the console forwarder.                             |
| `bridge-runtime/bridge-core.cjs`                                             | Generic bridge CLI (`runBridgeCli`); a host preset adds its commands, routes and recovery hints. |
| `metro/`                                                                     | Metro config wrapper, detached launcher and log generation/coalescing helpers.                   |
| `src/tool-paths.ts`, `src/devices.ts`                                        | adb/idb discovery (`RECIPE_RN_ADB_PATH`/`RECIPE_RN_IDB_PATH`) and connected-device listing.      |
| `src/video-recorder.ts`                                                      | Device video recorders.                                                                          |
| `src/metro-env.ts`, `src/source-freshness.ts`, `src/fingerprint-baseline.ts` | Bundle-input fingerprints with recorded baselines; the project supplies the inputs.              |

## Relationship to the harness

`@farmslot/adapter-rn` is a thin integration layer:

- `@farmslot/protocol` owns Recipe Protocol v1 schemas, action names, and validation.
- `@farmslot/recipe-runner` owns the generic runner, official core actions, UI actions, and CDP/React Native transports.
- `@farmslot/adapter-rn` adds Expo-friendly scaffolding (package scripts, a default recipe, optional dev-only React Native bridge/HUD files, integration checks) and the generic React Native runtime a harness drives: the Hermes bridge libraries, Metro helpers, device tools, recorders and freshness fingerprints. Product commands, routes and env names stay in the host harness.

### Bridge CLI preset

A host's bridge script is a preset over `runBridgeCli`:

```js
// my-app/bridge-runtime/cdp-bridge.cjs
const { runBridgeCli } = require('@farmslot/adapter-rn/bridge-runtime/bridge-core.cjs');
const { cdpEval } = require('@farmslot/adapter-rn/bridge-runtime/lib/cdp-eval.cjs');

runBridgeCli({
  appLabel: 'My App',
  routes: { aliases: { Home: 'HomeView' }, nestedParents: { SettingsDetail: 'Settings' } },
  teachingByErrorCode: { NO_TARGET: 'Next: open the app on the device.' },
  commands: {
    // `status` also gets the core's `status-selected` (the pinned target only).
    // Handlers get (client, args, { deviceName, platform, runtimeIdentity }).
    async status(client, _args, { deviceName } = {}) {
      return { route: await cdpEval(client, 'globalThis.__AGENTIC__?.getRoute?.()'), deviceName };
    },
  },
  commandDocs: { status: { help: '  status                       App status' } },
  // measure-scroll-transition: console lines starting with a prefix carry a JSON event.
  perfMarkerPrefixes: ['[MyAppPerf] '],
  // Evaluated only when a measure-scroll-transition request sets requireWalletReady: true;
  // it must return { ready, observedAtMs }, and the measurement refuses unless ready is true.
  readyExpression:
    '({ ready: Boolean(globalThis.__AGENTIC__?.getRoute?.()), observedAtMs: performance.now() })',
});
```

The built-in commands use the app's dev-only `globalThis.__AGENTIC__` bridge where present (`platform`, `getRoute`, `getState`, `navigate`, `canGoBack`, `goBack`, `pressTestId`, `pressText`, `queryUiTarget`, `setInput`, `scrollView`, `scrollIntoView`, and `showStep`/`hideStep` for the HUD). A host command that reuses a built-in name, or `status-selected`, throws at startup.

Do not add project-specific actions such as wallet, perps, or meetings to this package. Those belong in the app or a project-specific runner/manifest that extends the official harness actions. Generic whole-run video proof stays in the shared harness capability surface.

## What it installs

- a versionless `scripts/agentic/recipe/` scaffold;
- a small headless action manifest using official harness actions;
- an Expo config smoke recipe that emits the standard Farmslot artifact package;
- `recipe:*` package scripts;
- optional dev-only bridge/HUD files when `--with-bridge` is requested.

Protocol versioning remains inside recipe metadata. User-facing paths and scripts stay versionless.

### Native session ownership

Consumers of `createAgentDeviceUiTransport` can call `await transport.open()`
before using their shared SDK client for a snapshot. Later `execute` and
`observe` calls reuse that open session. Pair it with `await transport.close()`;
do not open or close the same client independently behind the transport.
This does not prepare a cold XCTest runner or bound snapshot latency.

## Usage

```bash
# Published package path, once @farmslot packages are public.
yarn add -D @farmslot/adapter-rn @farmslot/recipe-runner @farmslot/protocol
farmslot-adapter-rn init
yarn recipe:doctor
yarn recipe:validate
yarn recipe:dry-run
yarn recipe:run
```

Pass typed values with `--param key=value`. A task recipe at `artifacts/recipe.json` can keep task-only dependencies in `artifacts/recipe-library/`; the runner discovers them automatically.

`recipe:dry-run` still runs core/headless commands; it only stubs live UI, CDP,
and app bridge actions. Command output is sanitized before recipe artifacts are
written so public Expo config secrets do not leak into `trace.json`.

### Metro bridge port

Recipes that execute Metro-backed actions such as `app.status`, `app.hud`, or
`app.trace` must set `FARMSLOT_RECIPE_METRO_PORT` or `METRO_PORT` to the
assigned port (1–65535). `FARMSLOT_RECIPE_METRO_PORT` takes precedence. There
is no default port or `WATCHER_PORT` fallback. The port is resolved only when a
Metro-backed action runs, so headless and native-only recipes do not need it.

When asserting command output that may be redacted, prefer stable substrings or structured fields over exact pretty-printed JSON whitespace.

For motion-sensitive visual proof, `farmslot-adapter-rn run --record-video`
records one whole-recipe MP4 through `capture-helper`. By default it targets the
macOS Simulator window; override with `--record-pid`, `--record-window-id`, or
`--record-app-name` plus `--record-window-name`.

For a UI/HUD-capable app scaffold:

```bash
farmslot-adapter-rn init --with-bridge
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

1. **Stay thin.** Keep this package to Expo scaffolding and checks; generic execution belongs in `@farmslot/recipe-runner`.
2. **Keep manifests small and project-supported.** Do not add task-specific or ticket-specific actions.
3. **Parameterize before multiplying.** Prefer one parameterized domain action over duplicate narrow actions.
4. **Use UI/HUD actions only for visible proof.** Preparation and fixture convergence should stay separate from the measured proof nodes.
5. **Keep templates versionless.** Protocol versioning belongs in recipe metadata, not in generated path names.
6. **Run `yarn recipe:doctor` before handing a scaffolded project to Farmslot.**

## Local quality

```bash
yarn workspace @farmslot/adapter-rn quality
```

## License

MIT. See [LICENSE](LICENSE).
