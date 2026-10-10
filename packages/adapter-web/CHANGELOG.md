# Changelog

All notable changes to `@farmslot/adapter-web` are tracked here.

## Unreleased

## 0.6.9 - 2026-10-11

- Align the adapter-sdk and recipe-runner dependencies with 0.8.5 and 0.28.5 so consumers resolve one copy.

## 0.6.8 - 2026-10-10

- Publish with adapter-sdk 0.8.4 and recipe-runner 0.28.4 so consumers share one dependency copy. No code change.

## 0.6.7 - 2026-10-10

- Publish with adapter-sdk 0.8.3 and recipe-runner 0.28.3 so consumers share one adapter-sdk and one recipe-runner copy. No code change.

## 0.6.6 - 2026-10-09

- Fix: Chrome for Testing (`load-extension` mode) now launches with `--enable-unsafe-extension-debugging`, as branded Chrome already did. When the loaded extension called `chrome.runtime.reload()` (the MetaMask webpack dev server does on every background rebuild), Chrome 147 re-registered it as an unpacked extension and disabled it (`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`) because developer mode was off. The disable was saved in the slot profile, so every later launch showed `<id> is blocked` (`ERR_BLOCKED_BY_CLIENT`). The flag only prevents this. A profile that is already disabled stays disabled when relaunched with it.
- Fix: every fresh launch drops the profile's stored extension service worker registration (`Default/Service Worker/Database`, `ScriptCache`), so Chrome runs the background from the loaded build instead of whichever build first registered it. Extension storage and Cache Storage are kept.
- Publish with adapter-sdk 0.8.2 and recipe-runner 0.28.2 so consumers share one adapter-sdk and one recipe-runner copy.

## 0.6.5 - 2026-10-09

- A test now pins the web HUD limits that untrusted recipe sources rely on, now that `run` shows the HUD for them: recipe text capped at 180 characters and drawn as text in the closed shadow root, beside the RUN badge and the `step n/m` label. No behavior change.
- Publish with adapter-sdk 0.8.1 and recipe-runner 0.28.1 so consumers share one adapter-sdk and one recipe-runner copy.

## 0.6.4 - 2026-10-09

- Publish with adapter-sdk 0.8.0 and recipe-runner 0.28.0 so consumers share one adapter-sdk and one recipe-runner copy. No code change.

## 0.6.3 - 2026-10-09

- Fix: `launch-browser` stops waiting for its CDP listener once the browser it started has exited (`Chrome launched but did not expose an owned CDP listener on 127.0.0.1:<port>: the browser exited`), or once a process it did not launch holds the port (the same `Refusing to launch on CDP port <port>` refusal the pre-launch check gives, naming that pid). Either must hold for about a second, and a browser started through `open` counts as exited only once it has been seen, or after 5 s. The wait is now 30 s of wall-clock time; before, it was 300 polls: 30 s on an idle host, minutes on a loaded one. After the foreign refusal, once the browser this launch saw start is stopped, the launch markers are cleared, so a rerun on a free port is not refused as quarantined; if that browser was never seen, the markers stay and the refusal names the `rm` that clears them. An exit or a timeout keeps them, as before. A `ps` or `lsof` failure mid-wait now stops the browser before it is reported; if that stop fails too, one error names both failures and the pid to stop, and the markers are kept. Wait progress reports `seconds`, not `attempts`.
- `web-dapp`'s testnet launch probes build their mainnet URLs in node and pass them into the page as JSON strings, so a venue policy's probe `httpPath` or `wsPath` containing a quote reads as blocked or reached instead of failing the launch with a page `SyntaxError`.
- Fix: every process that loads the `web-dapp` venue policy fences its imports at run time. A `module.registerHooks` resolve hook refuses (`ADAPTER_PLUGIN_INVALID`) any import resolved from one of the policy's digested files (static, dynamic, or a `require` created for it) that lands outside them, at load or later while the process runs. Before, the host's source scan was the only check, so a leaf could load an outside file through an aliased `createRequire` (or another import the scan can't see) while the policy and plugin digests stayed unchanged. Loading the policy now needs Node.js 22.15 or later (`engines` says so). It fences imports, not code.
- Publish with adapter-sdk 0.7.2 and recipe-runner 0.27.1 so consumers share one adapter-sdk and one recipe-runner copy.

## 0.6.2 - 2026-10-08

- Fix: `launch-browser` no longer builds its `node -e` CDP request from the port, path or target id. They reach the child as argv, `cdpHttp` takes only an integer port from 1 to 65535 and the paths it uses (`/json/list`, `/json/version`, `/json/close/<id>`), and closing duplicate home tabs skips, with a warning, a target id from `/json/list` that is not a CDP id (letters, digits, `-`). Before, a hostile or substituted local CDP endpoint could run code in that child through a crafted target id. `cdpHttp` and `pruneExtraHomeTabs` are exported for tests. ([#859](https://github.com/deeeed/farmslot/pull/859))
- Publish with adapter-sdk 0.7.1 and recipe-runner 0.27.0 so consumers share one adapter-sdk and one recipe-runner copy.

## 0.6.1 - 2026-10-08

- `web-dapp` refuses a headful launch while the macOS login session is locked (`SESSION_LOCKED`, with the unlock step), before starting, reusing or stopping a browser, as mm-harness does since its #363 (0.6.0 shipped `web-dapp` without it). `macosSessionLocked()`, `parseSessionLocked()`, `SESSION_LOCKED_MESSAGE` and `SESSION_LOCKED_USER_ACTION` are exported.
- Publish with adapter-sdk 0.7.1 and recipe-runner 0.27.0 so consumers share one adapter-sdk and one recipe-runner copy.

## 0.6.0 - 2026-10-08

- Add `web-dapp` (`@farmslot/adapter-web/web-dapp`, an ESM subpath): `createWebDappAdapter({ id, signerModule, cli, hooks })` returns an `@farmslot/adapter-sdk` `PlatformAdapter` for a web app under test whose dev server the slot owns, moved from mm-harness's Web Terminal adapter. It runs a slot browser and wallet host with the injected strict wallet or a host-supplied extension signer, held to the testnet venue of the adapter that extends it. See the adapter-web reference for the signer module, venue policy and hooks.
- Publish with adapter-sdk 0.7.1 and recipe-runner 0.27.0 so consumers share one adapter-sdk and one recipe-runner copy.

## 0.5.0 - 2026-10-08

- `launchBrowser` takes an optional `progress` callback for the caller's stage: starting the browser, waiting for the CDP listener (with the attempt count, about every 5 s), loading the extension over CDP and opening the start window. The `[launch]` log lines are unchanged.
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
