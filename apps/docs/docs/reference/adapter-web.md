---
title: Web adapter
---

# Web adapter

`@farmslot/adapter-web` holds the browser side of a web platform: pick and launch an isolated Chromium, prove which process owns a CDP port, load an unpacked extension, select the page a recipe drives, move windows over CDP (a visible window moves without taking the operator's focus), and record or answer a dapp's wallet requests. It has no product knowledge. A harness passes its own build locks, titles, fixtures and signing policy in as arguments.

```js
const { resolveBrowser } = require('@farmslot/adapter-web/browser-resolver');
const {
  cdpListenerPids,
  connectBrowserCdp,
  placeWindow,
} = require('@farmslot/adapter-web/browser-cdp');
const { selectPageTarget } = require('@farmslot/adapter-web/page-target');
```

## Modules

| module                         | use it to                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `browser-resolver`             | choose Chrome for Testing or branded Chrome (probe-launched, cached) and how to load an extension                      |
| `browser-cdp`                  | talk to the browser over CDP with deadlines, follow its events, prove port ownership, load an extension, place windows |
| `page-target`                  | pick the page on an origin, preferring one whose URL carries a hash, or an extension's UI renderer                     |
| `performance-observer`         | trace an extension's UI renderer: frame timings and JavaScript tasks                                                   |
| `chrome-args`                  | build remote-debugging and isolated-profile flags, runtime identity and launch quarantine markers                      |
| `dapp`                         | record a web dapp's wallet requests, or answer them with a strict test wallet; assert the log                          |
| `extension-id`                 | compute a Chromium extension id from a manifest key or unpacked directory                                              |
| `launch-browser`               | launch or release one isolated, detached, owned Chromium with an unpacked extension                                    |
| `macos-focus`                  | give the front back to the previous app after a headed launch, by pid                                                  |
| `network-observer`             | capture the network requests of every target of a loaded extension                                                     |
| `origin`                       | compare exact app origins and tell whether a CDP context is the app's top frame                                        |
| `playwright-cdp`               | evaluate in a page over a raw CDP session (safe where page globals are scuttled)                                       |
| `slot-title`                   | prefix the extension home tab's title with the farm slot id, across the page's own title resets                        |
| `validation-process-ownership` | find and stop the processes that own a slot profile                                                                    |
| `validation-launch-supervisor` | supervise one validation launch: port lease, quarantine, cleanup                                                       |
| `web-dapp`                     | the generic web-dapp lifecycle as an adapter-sdk `PlatformAdapter` (ESM): slot browser, wallet host, readiness, stop   |

## Launching

`launchBrowser(options)` runs one launch end to end and returns `{ stopped: false, pid }` (or `{ stopped: true }` with `stopOnly`):

1. Refuse the CDP port if a process it can't prove is its own holds it. Proof is the exact `--user-data-dir`, or an extension path under the host's `extensionOwnerRoot`.
2. Stop the profile's previous owned browser and clear its singleton locks (`stopOnly` ends here).
3. Start the browser detached (macOS: Launch Services, in the background), load the extension, and keep one `homePage` tab.
4. Record `browser-resolution.json` and the runtime identity under `runtimeDir`, then give the front back if the browser took it.

The host passes what it knows about its product: `homePage`, `defaultTitle`, `extensionOwnerRoot`, `acquireRuntimeLock` (held for the whole launch) and the `rerunCommand` named in error hints.

## Observing an extension

Both observers connect with `connectBrowserCdp` to the browser on `cdpPort`. `connectTimeoutMs` and `commandTimeoutMs` default to 10 s.

- `createExtensionNetworkObserver({ cdpPort, runtimeDir, extensionId })` attaches to every target of the extension `extensionId` names (page, background, service worker), or, without it, of the first extension with a target (in a branded Chrome that can be a component or policy extension), and follows the ones that start later. Their `Network` events feed a `@farmslot/recipe-runner/cdp-broker` whose socket is keyed by `runtimeDir`. It returns a `NetworkCaptureBackend` (`@farmslot/adapter-sdk`): `start({ id, urlIncludes, methods, bodyJsonFields, maxRequests, maxDurationMs })`, `end(id)` with the capture summary, `close()`.
- `createExtensionPerformanceBackend({ cdpPort, extensionId, uiPaths, kind, platform, markerPrefix })` attaches to the extension's UI renderer. `selectExtensionTarget` picks it from `uiPaths`: the first path with an open page decides, and two renderers on that path refuse. It returns `@farmslot/recipe-runner/runtime/cdp-trace`'s collector. `kind` is the host's `TraceKind` (trace categories, scope, frame timing), and the clock marker `<markerPrefix><id>-<ms>` is written with `performance.mark` in that page.

```js
const { createExtensionPerformanceBackend } = require('@farmslot/adapter-web/performance-observer');

const backend = await createExtensionPerformanceBackend({
  cdpPort,
  extensionId,
  uiPaths: ['/home.html', '/sidepanel.html'],
  kind: extensionTraceKind,
  platform: 'extension',
});
await backend.start('swap');
const result = await backend.end('swap'); // { platform, javascript, nativeUi, trace, rawTraceEvents }
```

## Web dapps

`dapp` is the web3 layer for a dapp under test: the browser's wallet requests are recorded and, with the injected signer, answered by a strict test wallet. The wallet host (a process attached to the slot browser over CDP) puts three pieces together:

1. `pageScriptSource({ signer, appOrigin, refuseTypedData, injectedWallet })` is the preload to register with `Page.addScriptToEvaluateOnNewDocument`. It runs only in the app's top frame. With `signer: 'extension'` it wraps the provider a wallet extension injects; with `'injected'` it provides an EIP-1193 provider, announced over EIP-6963 with `injectedWallet.info`, whose requests go to the host. Every request in `LOGGED_METHODS` is reported through `LOG_BINDING` (method, EIP-712 primary type, domain and active chain, outcome, an error code and fixed category; never params or signatures). A request with no host binding attached is refused with 4100.
2. `createWalletRequestBinding({ client, appOrigin, signer, wallet, refuseTypedData, record, say })` is the host's side. It judges each binding call against the frame and document that made it: an iframe, a blank popup or a foreign page is refused and recorded as `outside-app-frame`, and a call it can't attribute within `PENDING_CALL_TTL_MS` is recorded as `unattributed`. The host calls `install` when it hooks a tab, `commit` when the tab's top frame commits a document, `drain` once the tab's domains are enabled and `detach` when it goes.
3. `createStrictWallet({ account, chainId })` answers the injected requests. It signs with the account the host passes and refuses what MetaMask refuses (typed data for another chain, another account), plus transactions; reads go to a public RPC.

`pageReadyExpression({ signer, refusesTypedData })` checks a committed document: the bindings are attached, the preload installed with this policy, and the provider the app sees wrapped.

Product policy is passed in. `refuseTypedData` is `{ reason, kind, message }`: typed data that `reason(typedData)` flags never reaches the signer. It is logged as `kind` and answered with code 4100 and `message`. `reason` also runs in the page, so it must be self-contained.

The log is read through `{ logFile, cursorFile }`:

- `windowSinceCursor` and `resetWindow` read the current window and start a new one.
- `evaluateSignatureLog(entries, node, policy)` and `awaitSignatureLog` (which retries until `node.timeout_ms`) check `allowed_primary_types`, `counts`, `request_counts`, `methods`, `max_typed_data_requests`, `expect_confirmations`, `require_active_chain` and `max_rejected`.
- `writeLogArtifact` keeps a window as run evidence.

`policy.typedDataClasses` adds limited counters (for example, session-key payloads at most `node.max_session_requests`, default 0); `policy.forbiddenEntries` adds entries that always fail.

```js
const {
  createStrictWallet,
  createWalletRequestBinding,
  pageScriptSource,
} = require('@farmslot/adapter-web/dapp');

const refuseTypedData = {
  reason: function productionReason(data) {
    return data?.message?.env === 'production' ? 'env=production' : null;
  },
  kind: 'refused-production',
  message: 'Refused: this run signs only for staging.',
};
const source = pageScriptSource({
  signer: 'injected',
  appOrigin,
  refuseTypedData,
  injectedWallet: { info: { uuid, name: 'Test wallet', icon, rdns: 'test.wallet' } },
});
const wallet = createStrictWallet({ account, chainId: 1 });
const binding = createWalletRequestBinding({
  client,
  appOrigin,
  signer: 'injected',
  wallet,
  refuseTypedData,
  record: (entry) => appendLine(logFile, entry),
});
```

## Web-dapp adapter

`@farmslot/adapter-web/web-dapp` (ESM) is the lifecycle of a web app under test whose dev server the slot owns. `createWebDappAdapter({ id, signerModule, cli, hooks })` returns an `@farmslot/adapter-sdk` `PlatformAdapter`: launch, stop, runtime status, doctor checks, logs and the wallet request-log findings. It runs one slot browser per slot, and a wallet host attached to it over CDP that records the wallet requests (and, with `signer=injected`, answers them with the strict wallet from `dapp`).

- **Venue policy.** The app's venue (the hosts a testnet run blocks and serves, the typed data to refuse, the start page) comes from the adapter that `extends: 'web-dapp'`: its policy module goes to `RECIPE_WEB_DAPP_POLICY` through `bindWebDappPolicy(adapter)`. Bare web-dapp has no policy and refuses to launch. `fencePolicy` and `assertPolicyDigest` hold the module and what it imports to the files the plugin digest covers.
- **Signers.** `signer=injected` needs nothing. `signer=extension` belongs to the host: a signer module exports `signers.extension` with `prepareProfile` (load the extension, seed the profile; returns `{ browserArgs, secrets, state }` and may carry an `afterBrowserStart` step; both steps get `trackSecret` for key-material files), `confirm` (required with `prepareProfile`: without it the wallet host would close the wallet's own windows) and `readinessChecks`. `signers.injected.identity` sets the EIP-6963 identity the injected strict wallet presents. The module path (`signerModule`, `--signer-module` or `RECIPE_WEB_DAPP_SIGNER_MODULE`) is the one source: readiness, launch, verify and the wallet host all load it, and `createWebDappAdapter` throws if given an in-process `signers` object. With no signer requested, the signer is `extension` when a module is configured and `injected` otherwise.
- **Hooks.** The action set, console capture, and network and performance observation are the host's; pass them as `hooks`. `diagnostics`, `readiness` and `harness` merge over the generic members.
- **Leaves.** `webDappLeafPath('launch' | 'wallet-host' | 'inject' | 'verify' | 'stop' | 'cleanup')` names the CLI scripts.

```js
import { createWebDappAdapter } from '@farmslot/adapter-web/web-dapp';

const adapter = createWebDappAdapter({
  id: 'web-dapp',
  signerModule: '/path/to/signers.mjs', // exports { signers: { extension, injected } }; omit for injected-only
  hooks: { actions },
});
```

## Resolver CLI

`node browser-resolver.cjs <command>` runs one bounded call (at most 120 s; exit 0, or 1 with the message on stderr):

| command         | arguments                                                                                                                                                              | stdout                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `resolve`       | `[--target <checkout>]` (default: cwd) `[--launch-method spawn\|launch-services]` `[--display headless\|headful]` `[--recorded <file>]` `[--out <file>]...` `[--json]` | the browser path, or the resolution record with `--json` |
| `load-unpacked` | `--port <cdp> --path <dist> --profile <dir>` `[--expect-id <id>]` `[--open-url <url>]` `[--timeout-ms <ms>]`                                                           | `{ id, otherExtensions, owner }`                         |
| `open-window`   | `--port <cdp> --url <url>`                                                                                                                                             | `{ targetId }` of a new background window                |

## Users

- The MetaMask harness (`@deeeed/metamask-harness`) builds its Extension and Terminal launches on these modules (its Extension launcher is `launchBrowser` with MetaMask's home page, title and build lock) and vendors the package into the overlay it installs in a checkout. Its Web Terminal wallet host is `dapp`, with Hyperliquid's testnet refusal and the MetaMask identity of its injected wallet passed in.
- Command Center's recipe runner (`apps/command-center/scripts/agentic/run-recipe.mjs`) selects its page, finds the CDP browser pid and places the recording window with them.
