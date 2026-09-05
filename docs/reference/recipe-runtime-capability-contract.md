# Recipe Runtime Capability Contract v1

> This document is capability/manifest guidance for Recipe Protocol v1 runners. The canonical protocol source of truth is [Recipe Protocol v1](recipe-protocol-v1.md).
> This document defines the runtime seam between Farmslot, project runners, and
> skills. It is the contract that keeps the base harness portable while still
> allowing projects such as Example App to expose high-leverage custom actions.

## Boundary summary

| Layer                      | Owns                                                                                                | Must not own                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Farmslot protocol          | Recipe schema, action manifest schema, official action names, trace/summary/artifact package shape. | Product concepts such as wallets, Perps, app routes, fixture secrets, selectors. |
| `@farmslot/recipe-harness` | Graph execution, core adapters, official `ui.*` adapter host, generic runtime capability helpers.   | Project-specific target discovery, account setup, domain assertions.             |
| Base runtime helpers       | CDP sessions, web page UI driver, browser-extension target helpers, React Native bridge contract.   | Example App extension IDs, Example App profile seeding, Perps controller calls.  |
| Project runner             | Composes base helpers with app-specific target providers and custom actions.                        | A second recipe schema or graph executor.                                        |
| Skill                      | Resolves/installs/runs the runner and reads manifests.                                              | Harness runtime implementation.                                                  |

## Capability families

### Core/headless

Base package: `createStandardCoreAdapters()`

Actions: `command`, `wait`, `assert_file`, `assert_json`, `assert_exit_code`,
`assert_output`, `state_read`, `watch_logs`, `index_artifacts`, `call`, `switch`, `manual`, `end`.

Use for backend services, CLI projects, static checks, and artifact-only proof.

### UI

Base package: `createStandardUiAdapters({ transport })`

Actions: `ui.navigate`, `ui.press`, `ui.key_press`, `ui.set_input`,
`ui.scroll`, `ui.swipe`, `ui.pan`, `ui.drag`, `ui.long_press`, `ui.wait_for`,
`ui.screenshot`, plus app-level helpers such as `app.status`, `app.lifecycle`,
`app.hud`, and `app.trace` when the platform can expose them.

Farmslot owns the action semantics and, for common platform families, the
transport implementation. A runner should first compose a base Farmslot transport
(`createCdpWebUiTransport`, `createReactNativeCdpBridgeUiTransport`, etc.) and
supply only the runtime binding: page/target selection, CDP port, bridge
command/eval hooks, screenshot destination, and launch policy. A runner should
implement custom `ui.*` transport methods only when the platform family is not
yet covered by Farmslot. Transport results are treated as node output by default;
graph control requires an explicit `{ control: ... }` wrapper.

### HUD / overlay visual proof

`app.hud` is the UI-class capability for reviewer-facing overlays during live
playback and proof-window recording. For UI-capable runners it is a first-class
progress loop, not a task-local convenience action. Farmslot defines the
semantics: display run status/progress plus one human intent by default, without
changing app state. Flow/domain, phase, node id, action name, proof target, and
record policy are trace/debug metadata, not default HUD copy. Platform transports
decide only how to render it: DOM overlay for web/extension, React Native
injected overlay/bridge command for RN, native test-host overlay for native apps,
or unsupported for headless projects.

HUD rendering is project-configurable. The base harness may provide defaults,
but each runner owns its display policy: overlay bar, docked bottom bar with
reserved app space, card, top/bottom/corner placement, title visibility, debug
metadata visibility, width, and detail-line budget. The project must not fork the action semantics to change presentation.

HUD intent contract:

- `intent` is the agent-to-human explanation of the current goal. Write it as a short verb phrase or sentence a reviewer can understand without knowing the recipe schema.
- `intent` must not be an action name, domain name, node id, selector, test id, implementation primitive, or generic label such as `ui`, `wallet`, `perps`, `setup`, or `run`.
- `flow`/`domain` describe organization for trace/debug only; they are hidden by default.
- `detail` is optional supporting context for trace/review metadata; runners hide it from the default HUD unless `display.showDetail: true` is explicitly configured.

Default display rules:

- show one intent: `RUN 12/19 Open a small ETH long position`;
- keep the default HUD to one current-intent line; runners may internally retain parent/child flow context for trace/debug views;
- show a secondary HUD line only for explicit detail/debug display or failure/error information;
- hide `flow`, `domain`, node id, action name, and proof target unless
  `display.showDebug` is enabled.

A runner that advertises HUD/overlay must:

- include `app.hud` in the action manifest and register the official UI adapter;
- let the base harness publish automatic `running`, `pass`, `fail`, and
  `complete` HUD updates for graph nodes;
- reserve explicit recipe `app.hud` nodes for extra reviewer annotations;
- fail validation if the advertised HUD transport cannot render, rather than
  silently dropping reviewer feedback;
- ensure overlays do not cover the visual claim, or emit a paired raw artifact;
- keep overlay injection in the runner/harness layer, not in skill docs or
  product-domain actions.

### CDP / web

Base package exports:

- `CdpSession`
- `CdpWebPage`
- `jsonGet`
- `retryJsonGet`
- `selectCdpTarget`
- `selectorForUiInput`
- `createCdpWebUiTransport`

Use for any browser or WebView-like surface that can be controlled through
Chrome DevTools Protocol. The base driver covers generic page operations:
navigate, evaluate, click, fill, scroll, wait, screenshot, and safe artifact
paths.

A web project should only implement target selection and launch policy, then
compose the base transport:

```ts
createStandardUiAdapters({
  transport: createCdpWebUiTransport({
    async getPage(context) {
      return connectToTheProjectPage(context);
    },
  }),
});
```

### Browser extension

Base package exports:

- `selectBrowserExtensionPageTarget`
- `extensionIdFromTarget`
- `openBrowserExtensionPage`

Use for Chrome extension style projects. Farmslot provides generic target
selection and extension-origin derivation. The project runner owns build/profile
launch policy and domain actions.

For Example App this means generic browser-extension mechanics stay in Farmslot,
while wallet fixture seeding, unlock semantics, background API calls, Perps
state, and Example App selectors stay in the Example App runner.

### React Native / cross-platform app bridge

Base package exports:

- `ReactNativeBridge`
- `ReactNativeBridgeCommand`
- `createReactNativeBridgeUiTransport`

Use for React Native apps on iOS and Android. Farmslot defines the command
contract and maps official `ui.*` actions to bridge commands. A project supplies
the bridge transport: Hermes/CDP, Metro debugger, Detox, Maestro, native test
host, or a project-local app-control service.

The generic bridge commands are:

| Command      | Purpose                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `navigate`   | Move to route/screen/view.                                                                        |
| `press`      | Press visible selector/testID/text.                                                               |
| `setInput`   | Set text through a supported input path.                                                          |
| `scroll`     | Scroll a view/window, or bring a selector/test id into view when `scroll_into_view` is requested. |
| `waitFor`    | Wait for visible selector/text/condition.                                                         |
| `screenshot` | Capture device/simulator evidence when implemented.                                               |

The bridge must drive supported app/user or test-host paths. It must not mutate
React/Redux/MobX state to fabricate proof.

## Run resource posture

Runtime capability leases say who owns a provider. The **resource posture**
(ADR-054) says which providers should be live at the run's current lifecycle
boundary. The Gateway owns it. Recipes, runners, skills, and clients read it and
never resolve it themselves, and never stop a provider with their own shell
command — every change goes through the capability provider's declared release
action.

### The four postures

| Posture         | Intent                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `active`        | Keep only the capabilities the current proof plan requires acquired and healthy.                  |
| `operator-wait` | Apply the effective retention policy while the run waits for an operator or CI.                   |
| `parked`        | Delegate to machine parking for this one run: stop worker and manifest resources, keep workspace. |
| `terminal`      | Stop every run- and family-owned capability in dependency order, bypassing keep-warm.             |

Preparing a validation or a recipe rerun is not a fifth posture. It is `active`
with the validation's proof plan re-applied: the Gateway reacquires the selected
proof requirements and passes their health checks before the action starts.

### The four gate choices

A human-gate decision carries one operator choice, which resolves to a posture
plus a proof plan.

| Choice                | Resolves to                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `keep-for-validation` | `active` with the validation proof plan                            |
| `minimize`            | `operator-wait` with expensive providers released, worker retained |
| `free-slot`           | `parked`; a typed rejection until the run is park-eligible         |
| `project-default`     | Whatever the lower precedence levels resolve to                    |

### Precedence

The effective policy resolves in this order, and the winning level is recorded on
every decision as its policy source:

1. **`gate-choice`** — the operator's choice for the current wait.
2. **`run-dispatch`** — the run's `waitPolicy`, copied from backlog dispatch
   settings at creation, so a batch or overnight dispatch presets every wait.
3. **`project-default`** — `runtime_capabilities.posture.defaults` and a
   provider's own `retention` map in `project.json`; the provider overrides the
   project default.
4. **`framework-default`** — retain what keeps the current operator action
   usable, release expensive unneeded providers at durable waits, stop every
   run-owned provider at terminal.

A client cannot widen an operator choice or invent its own cleanup policy.
Projects configure retention only for `operator-wait` and `terminal`: `active` is
derived from the proof plan and `parked` delegates to machine parking, and
`terminal` accepts only `stop`.

```json
{
  "runtime_capabilities": {
    "posture": { "defaults": { "operator-wait": "warm", "terminal": "stop" } },
    "providers": {
      "browser-cdp": {
        "keep_warm_ms": 600000,
        "retention": { "operator-wait": "warm", "terminal": "stop" }
      },
      "companion-metro": { "retention": { "operator-wait": "stop", "terminal": "stop" } }
    }
  }
}
```

### Warm is not stopped

Posture status reports two independent things per capability, and they must never
be collapsed into one:

- **desired disposition** — `acquired`, `warm`, or `stopped`: what the Gateway
  intends.
- **observed provider state** — `running`, `stopped`, `unhealthy`,
  `transitioning`, or `unknown`: what it saw.

`warm` gives up ownership but deliberately keeps a healthy provider alive until
an explicit deadline, so a released lease with a live keep-warm provider is
observed `running`. Reacquiring a warm healthy provider reuses it through the
existing health contract; an unhealthy one is cleaned up first. A provider is
reported `stopped` only when the Gateway observed it stop — a failed cleanup
leaves it `unhealthy` or `unknown` with a reason attached, never `stopped`.

### Runner sessions are not runtime capabilities

Posture never touches a runner session. Session retention, handoff, and resume
stay in the shared runner capability layer, and no posture resolved here stops a
gate-held worker (ADR-038). Stopping a worker belongs to machine parking, which
is what `parked` delegates to and which excludes gate-held runs today. Posture
status may report whether the worker is live; runtime providers never implement
runner resume commands.

### Operator commands

```bash
farmslot resource posture status <runId>
farmslot resource posture preview <runId> --posture operator-wait
farmslot resource posture preview <runId> --choice minimize
farmslot resource posture apply <runId> --choice minimize --operation-id <key>

farmslot resource capability acquire <slotId> <capabilityId> --run <runId> --reason <text>
farmslot resource capability release <slotId> --run <runId> --capability <capabilityId> [--stop]
farmslot resource capability stop-warm <slotId> <capabilityId>
```

`preview` returns exactly what would be acquired, retained, warmed, or stopped
and the declared release effects, before an operator commits. `apply` takes an
`--operation-id` idempotency key: replaying it returns the stored transition
instead of executing again. `stop-warm` is the only way to stop a provider a
released lease is keeping alive — a plain release reports success while the
provider keeps running. Every command accepts `--json` and prints the Gateway's
result unchanged.

## Project runner composition rule

A runner should be mostly composition:

```text
Base core adapters
+ Base UI adapters
+ Base runtime helper transport (CDP/web/RN/extension)
+ Project custom action adapters
= Project runner
```

Custom action namespaces are for domain semantics, not for reimplementing base
controls. For Example App, `example.wallet.*` and `example.trade.*` are valid
custom namespaces; generic names such as `extension.click`, `mobile.scroll`, or
`browser.screenshot` are not.

### Task-specific proof

Acceptance-criteria checks that exist for one ticket or demo do not become base or project capabilities just because a recipe needs them. The reusable layers should expose primitives such as `ui.wait_for`, `ui.screenshot`, `cdp.*`, and domain actions such as `example.trade.assert_positions({ state, market })`. A one-off claim like a specific banner color, copy string, or visual placement belongs in that recipe's task-local validation artifact or evidence narrative unless it is promoted into a broadly reusable action with a neutral schema.

## Shared capability profiles

For multi-platform projects, publish a shared domain interface matrix in addition to executable action manifests. The executable manifest must list only actions the runner can run. The capability profile may also list `partial`, `unsupported`, or `planned` capabilities so agents can understand platform parity and avoid inventing different Mobile/Extension vocabularies.

Use this for domains such as wallet/perps: define the common interface once, then record Mobile and Extension support status per capability. Unsupported capabilities are not callable; they are review/planning signals.

## Recipe discoverability

Action manifests describe atomic runner capabilities. Recipe libraries publish parameterized graphs that compose those actions. Agents discover recipes with `run --list` and `run <id> --describe`, then inspect the action manifest only when no existing recipe fits.

Farmslot owns recipe indexing, `call` execution, validation, nested trace, and artifact mapping. Project and team libraries own domain recipes such as `example.trade.start_state`.

## Manifest discoverability

Every runner manifest should declare:

- one keyed `actions` allowlist;
- strict schemas and copyable examples for every action;
- explicit `execution_capabilities` for every custom action.

The loader derives official/custom identity from the protocol registry and source
identity from resolution provenance. Agents should use runner discovery instead
of guessing actions.

## Injection rule

Injection installs a runner and its target-specific provider code into ignored
checkout paths so the same capability is available on fresh checkouts and
historical commits. Injection does not change ownership boundaries:

- Farmslot runtime helpers remain Farmslot-owned;
- project runners remain project-owned;
- skills remain resolver/install/run UX.
