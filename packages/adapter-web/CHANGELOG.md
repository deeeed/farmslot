# Changelog

All notable changes to `@farmslot/adapter-web` are tracked here.

## Unreleased

- `launchBrowser` takes an optional `progress` callback for the caller's stage: starting the browser, waiting for the CDP listener (with the attempt count, about every 5 s), loading the extension over CDP and opening the start window. The `[launch]` log lines are unchanged.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.4.2 - 2026-10-07

- Publish with adapter-sdk 0.7.0 and recipe-runner 0.26.0 so consumers share one adapter-sdk copy.

## 0.4.1 - 2026-10-07

- `network-observer`: `createExtensionNetworkObserver` takes an optional `extensionId`, the extension to capture. Without it the observer still takes the first extension with a target, which in a branded Chrome can be a component or policy extension listed before the one under test.
- Publish with adapter-sdk 0.6.0 and recipe-runner 0.26.0.

## 0.4.0 - 2026-10-06

- Add `network-observer` (`createExtensionNetworkObserver({ cdpPort, runtimeDir })`) and `performance-observer` (`createExtensionPerformanceBackend({ cdpPort, extensionId, uiPaths, kind, platform, markerPrefix })`), the Extension network and performance observers moved from mm-harness. The network observer attaches to every target of the loaded extension and feeds their Network events to a `@farmslot/recipe-runner/cdp-broker`; it returns an `@farmslot/adapter-sdk` `NetworkCaptureBackend`. The performance observer traces the extension page found at the first of `uiPaths` with exactly one open renderer, through `@farmslot/recipe-runner/runtime/cdp-trace`. Both run on `connectBrowserCdp`; `connectTimeoutMs` and `commandTimeoutMs` default to 10 s. The package now depends on `@farmslot/recipe-runner` and `@farmslot/adapter-sdk`.
- `browser-cdp`: `connectBrowserCdp` clients gain `onEvent(handler)` (every CDP event, as `{ method, params, sessionId? }`; events were dropped before) and `onClose(handler)` (once, when the socket closes; at once on a client that has already closed), each returning an unsubscribe function. `onEvent` on a closed client keeps nothing. Add `asBrowserCdpTarget` and `extensionIdFromCdpTargets`.
- `page-target`: add `selectExtensionTarget(targets, extensionId, { paths })`, the extension UI renderer at the first path with any match, or null when that path has several.
- Publish with adapter-sdk 0.5.1 and recipe-runner 0.26.0.

## 0.3.1 - 2026-10-06

- Browser probes no longer leave Chrome for Testing running when the resolver is stopped mid-probe (a hook timeout, a signal, or the resolver killed outright): the probe browser and its temporary profile are removed.
  - A resolver killed outright cannot clean up; the next probe by the same user stops its browser and removes its profile. `browser-resolver` exports that step as `reapOrphanedProbes(tmp?)`.

## 0.3.0 - 2026-10-05

- Add `dapp`, the web3 layer for a dapp under test, moved from `@deeeed/metamask-harness`'s Web Terminal adapter: the strict EIP-1193 test wallet (`createStrictWallet`), the page script that wraps the app's provider and logs its wallet requests or injects a provider the host answers (`pageScriptSource`, `pageReadyExpression`), the host's side of its bindings (`createWalletRequestBinding`: frame and document attribution, `outside-app-frame` and `unattributed` records, refusals) and the wallet request log (`windowSinceCursor`, `resetWindow`, `evaluateSignatureLog`, `awaitSignatureLog`, `writeLogArtifact`). Product policy is passed in: the typed data to refuse (`refuseTypedData`), the injected wallet's EIP-6963 identity and the log entries and typed-data classes a product forbids. Page bindings are `__farmslotWallet{Log,Request,Resolve}` and the page marker `__farmslotDapp`.
- Add `origin` (`isAppUrl`, `originOf`, `isAppTopFrameContext`, `shortUrl`): exact app-origin checks, moved from the same adapter.

## 0.2.0 - 2026-10-05

- Add `launch-browser` (`launchBrowser`: launch or release one isolated, detached, owned Chromium with an unpacked extension; `homeTabsToClose`) and `slot-title` (stamp the farm slot id into the extension home tab's title), moved from `@deeeed/metamask-harness`. Product knowledge is now passed in: the home page, its default title, the owner-root rule, a lock held for the launch, and the rerun command named in hints. `slot-title`'s `applyPersistentSlotTitle` takes `{ slotId, defaultTitle }`, `buildStampExpression(slotId, defaultTitle)` and `stampHomeTabsViaCdp({ homePage, defaultTitle, ... })` match it, and CDP stamping uses the global `WebSocket` (else `ws`), loaded only when it stamps.
- README: document the `browser-resolver.cjs` command (`resolve`, `load-unpacked`, `open-window`): arguments, output, exit codes and the 120 s bound.

## 0.1.0 - 2026-10-04

- Add the package with the browser process and CDP layer moved from `@deeeed/metamask-harness`, unchanged in behaviour: `browser-resolver` (Chrome for Testing vs branded Chrome, probe cache, `runCli` entry), `browser-cdp` (deadline-bound browser CDP client, CDP-port ownership proof, `Extensions.loadUnpacked`, extension isolation), `chrome-args` (remote-debugging flags, runtime identity nonce, launch quarantine), `extension-id`, `macos-focus`, `playwright-cdp` (LavaMoat-safe page evaluation), `validation-process-ownership` and `validation-launch-supervisor`. Process, on-disk and environment names are Farmslot's: `--farmslot-runtime-nonce=`, `.farmslot-detached-launch-unproven`, `/tmp/farmslot-browser-validation-<uid>`, `~/.cache/farmslot/browser-probe.json`, `farmslot-browser-probe-*`, `FARMSLOT_FOCUS_HOLD`, `FARMSLOT_FOCUS_BROWSER` and `FARMSLOT_VALIDATION_PORT_LEASE`; remediation hints name no product command.
- Add `page-target` (`selectPageTarget`: the page on an origin, preferring one whose URL carries a hash) and `browser-cdp.placeWindow` (move a target's window over CDP; a visible window moves without activating the browser).
- Every module's exports are named bindings Node's CommonJS export detection can read, so ESM named imports work (`import { probeLaunch } from '@farmslot/adapter-web/browser-resolver'`); a package test checks `import()` against `require()` for each export.
