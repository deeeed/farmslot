# Companion mobile (optional — only when the task touches apps/companion)

Default `farmslot` prepare (`sandbox` / `attach`) boots **gateway + Command Center UI only**.
Do **not** boot a simulator, start Metro, or launch the companion app unless this task
explicitly requires companion runtime proof (recipe, UI, pairing, device behavior).

When companion work **is** in scope, you own isolated device + Metro setup the same way
other mobile farm slots do — via explicit env injection, not interactive prompts
in non-TTY agent runs.

## Slot isolation (read from pool + worktree)

Each worktree/slot should have its own:

| Var | Source | Example (ff-2) |
|-----|--------|----------------|
| Gateway | slot `dev-server.port` | `8809` |
| Metro | slot `dev-server.metro_port` or operator `.env.ports` | `8879` (explicit; never shared 8081) |
| iOS sim | pool `ios-sim.simulator` or worktree `agentic.local.conf` | `ff-2` sim name |
| Android | pool `adb_serial` / `avd` or `agentic.local.conf` | `emulator-5582` |

Gateway URL for the app must match **this checkout's gateway port**, not hardcoded 7777:

```bash
export GATEWAY_PORT=8809   # from slot
export METRO_PORT=8879     # from slot
export EXPO_PUBLIC_GATEWAY_URL="ws://127.0.0.1:${GATEWAY_PORT}/ws"
```

Per-worktree device pins live in gitignored `apps/companion/scripts/agentic/agentic.local.conf`
(copy from `agentic.local.conf.example` if present).

## iOS simulator (agent-driven, optional)

1. Confirm sim exists: `xcrun simctl list devices -j | python3 -c "..."` or match pool name.
2. Boot if not running (prepare does **not** auto-boot):
   ```bash
   xcrun simctl boot '<simulator-name>'
   open -a Simulator
   ```
   Or from Command Center: resource `ios-sim` → **boot** (uses `projects/farmslot-farm/project.json` hooks when dispatched as that project).
3. Start Metro + dev client on isolated port:
   ```bash
   cd apps/companion
   PLATFORM=ios DEVICE_MODE=simulator \
     IOS_SIMULATOR='<simulator-name>' \
     METRO_PORT=<metro-port> \
     GATEWAY_PORT=<gateway-port> \
     EXPO_PUBLIC_GATEWAY_URL="ws://127.0.0.1:<gateway-port>/ws" \
     bash scripts/agentic/start.sh --ios
   ```

## Android device/emulator (agent-driven, optional)

1. Confirm device: `adb -s '<serial>' get-state` must print `device`.
2. Boot AVD if needed (pool `avd` + `adb_serial`); no blanket `adb reverse tcp:8081`.
3. Slot-scoped reverse only:
   ```bash
   adb -s '<serial>' reverse tcp:<metro-port> tcp:<metro-port>
   ```
4. Launch:
   ```bash
   cd apps/companion
   PLATFORM=android DEVICE_MODE=device \
     ADB_SERIAL='<serial>' \
     METRO_PORT=<metro-port> \
     GATEWAY_PORT=<gateway-port> \
     EXPO_PUBLIC_GATEWAY_URL="ws://127.0.0.1:<gateway-port>/ws" \
     bash scripts/agentic/start.sh --android
   ```

## Companion bridge proof — critical gotchas

### The app/dev client must be launched, not just Metro

`companion-warm` prepare starts Metro and the simulator, but the React Native bridge is only
available after the **dev client (Expo Go or the native build) connects to Metro**. Bridge
polling (`app.status`, `observeUi`, etc.) will time out if the app is not launched.

- Use `prepare-profile.sh full` (or the `companion-full` prepare profile) which performs a
  native build + app launch, not only Metro readiness.
- After prepare, verify the bridge is reachable before running a companion recipe — run the
  bridge smoke from `apps/companion` (Metro must be up with the recipe relay middleware and the
  dev client launched with `EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1`; see `apps/companion/AGENTS.md`):
  ```bash
  cd apps/companion && yarn recipe:run:bridge
  # a passing bridge smoke proves the app is connected; a timeout means it is not
  ```
- Only after the bridge smoke passes should you run `validate-recipe.sh --platform ios` (or `android`).

### Bridge command names differ from recipe action names

When probing the bridge directly (e.g. via `cdp.mjs gateway`), use **bridge-level command names**:

| Direct probe (bridge-level) | Recipe action name |
|-----------------------------|--------------------|
| `status` | `app.status` |
| `observeUi` | `app.observeUi` |

The React Native bridge transport maps recipe action names (e.g. `app.status`) to their
bridge-level names before sending. Using the recipe action name in a direct probe will fail;
using the bridge-level name in a recipe document will fail validation against the action manifest.

### Companion action manifest scope

The companion action manifest does not currently expose all Command Center actions. Specifically,
`ui.press` with `observe:false` and the observation policy variants are not yet repo-supported
recipe actions on the companion surface. Do not attempt to mirror Command Center observation
policy proof in companion recipes — validate `observeUi` directly instead, and note the gap
in `recipe-coverage.md`.

## What not to do

- Do not add simulator boot to default `sandbox` prepare or `yarn farmdev`.
- Do not use shared Metro 8081 across parallel worktrees.
- Do not inject UI state to fake companion outcomes — drive real taps/keystrokes for evidence.
- Do not assume `projects/farmslot-farm` pool slots exist on every machine; when absent,
  pin devices in `agentic.local.conf` and document the choice in the task report.
- Do not poll the bridge with recipe action names (`app.status`) in direct CDP probes — use
  the bridge-level name (`status`) for direct probes and reserve action names for recipe documents.

## Validation

- Gateway: `curl -sf "http://127.0.0.1:<gateway-port>/health"`
- Metro: `lsof -nP -iTCP:<metro-port> -sTCP:LISTEN`
- iOS: `xcrun simctl list devices booted | grep -q '<simulator-name>'`
- Android: `adb -s '<serial>' get-state`
- Bridge: `cd apps/companion && yarn recipe:run:bridge` (passing smoke = app connected)
- Companion recipes: `projects/farmslot-farm` `recipe_run` hook when slot is configured for that project.
