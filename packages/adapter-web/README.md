# @farmslot/adapter-web

Web platform pieces for Farmslot recipes: pick and launch an isolated Chromium, prove which process owns a CDP port, load an unpacked extension, give macOS focus back after a headed launch, and record (or answer) a dapp's wallet requests. A harness builds its `web` platform on these; the modules hold no product knowledge.

```js
const { resolveBrowser } = require('@farmslot/adapter-web/browser-resolver');
const { connectBrowserCdp, waitForCdpOwner } = require('@farmslot/adapter-web/browser-cdp');
const { activateMacAppByPid } = require('@farmslot/adapter-web/macos-focus');
```

Docs: https://farmslot.io/docs/reference/adapter-web

## Source layout

| module                         | owns                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `browser-resolver`             | Chrome for Testing vs branded Chrome, probe-launch and its cache, extension loading method; CLI entry                     |
| `browser-cdp`                  | browser-level CDP client with deadlines and events, CDP-port ownership proof, `Extensions.loadUnpacked`, window placement |
| `chrome-args`                  | remote-debugging flags, isolated profile flags, runtime identity nonce, launch quarantine markers                         |
| `dapp`                         | web dapps: strict EIP-1193 test wallet, wallet-request page script and its host binding, wallet request log               |
| `extension-id`                 | Chromium extension id from a manifest key or an unpacked directory                                                        |
| `launch-browser`               | launch (or release) one isolated, detached, owned Chromium with an unpacked extension                                     |
| `macos-focus`                  | capture the frontmost app before a headed launch and restore it if one of our browsers took it                            |
| `network-observer`             | network capture for every target of a loaded extension, through recipe-runner's CDP broker                                |
| `origin`                       | exact app-origin checks, the app top-frame CDP context check, URLs without query strings                                  |
| `page-target`                  | pick the page on an origin, or an extension's UI renderer by path                                                         |
| `performance-observer`         | CDP performance traces of an extension's UI renderer, through recipe-runner's trace collector                             |
| `playwright-cdp`               | page evaluation over a raw CDP session (safe under LavaMoat scuttling)                                                    |
| `slot-title`                   | prefix the extension home tab's title with the farm slot id, kept across the page's own title resets                      |
| `validation-process-ownership` | find and stop the processes that own a slot profile                                                                       |
| `validation-launch-supervisor` | supervised child for one validation launch: port lease, quarantine and cleanup                                            |
| `web-dapp`                     | the generic web-dapp lifecycle as an adapter-sdk `PlatformAdapter` (ESM): slot browser, wallet host, readiness, stop      |

Sources are CommonJS (`src/**/*.cjs`) and ship as is; `yarn build` emits `.d.cts` declarations. `web-dapp` is the exception: its sources are ESM (`src/web-dapp/**/*.mjs`, declarations `.d.mts`), because its leaf scripts run as their own node processes. Every library subpath can be `require`d or `import`ed with named imports, except `validation-launch-supervisor`: it is a child-process entry (it runs when loaded), so hosts `require.resolve` it and fork it.

## Launching a browser

`launchBrowser` is synchronous and owns one launch end to end: it refuses a CDP port held by a process it cannot prove is its own, stops the previous owned browser of the profile, starts the browser detached (on macOS through Launch Services in the background), loads the extension, records the resolution and runtime identity under `runtimeDir`, and gives the front back if the new browser took it. `stopOnly: true` does only the release part.

```js
const { launchBrowser } = require('@farmslot/adapter-web/launch-browser');

launchBrowser({
  cdpPort: 9333,
  chromeBin,
  profile: `${runtimeDir}/profile`,
  extensionDir: `${runtimeDir}/runtime-dist`,
  runtimeDir,
  chromeLog: `${runtimeDir}/logs/chrome.log`,
  chromePid: `${runtimeDir}/logs/chrome.pid`,
  // Product knowledge comes from the host:
  homePage: 'home.html', // opened first, kept to one tab
  defaultTitle: 'My Extension', // the page's own title; a slot-stamped tab is the one kept
  acquireRuntimeLock: (dir) => lockBuild(dir), // returns its release
  extensionOwnerRoot: (dir) => ownerRootFor(dir), // another way to prove a browser is ours
  rerunCommand: 'my-harness launch',
});
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

`@farmslot/adapter-web/web-dapp` (ESM) is the lifecycle of a web app under test whose dev server the slot owns. `createWebDappAdapter({ id, signers, signerModule, cli, hooks })` returns an `@farmslot/adapter-sdk` `PlatformAdapter`: launch, stop, runtime status, doctor checks, logs and the wallet request-log findings. It runs one slot browser per slot, and a wallet host attached to it over CDP that records the wallet requests (and, with `signer=injected`, answers them with the strict wallet from `dapp`).

- **Venue policy.** The app's venue (the hosts a testnet run blocks and serves, the typed data to refuse, the start page) comes from the adapter that `extends: 'web-dapp'`: its policy module goes to `RECIPE_WEB_DAPP_POLICY` through `bindWebDappPolicy(adapter)`. Bare web-dapp has no policy and refuses to launch. `fencePolicy` and `assertPolicyDigest` hold the module and what it imports to the files the plugin digest covers.
- **Signers.** `signer=injected` needs nothing. `signer=extension` belongs to the host: a signer module exports `signers.extension` with `prepareProfile` (load the extension, seed the profile; its result may carry an `afterBrowserStart` step), `confirm` and `readinessChecks`; the leaf processes find it through `--signer-module` or `RECIPE_WEB_DAPP_SIGNER_MODULE`.
- **Hooks.** The action set, console capture, and network and performance observation are the host's; pass them as `hooks`. `diagnostics`, `readiness` and `harness` merge over the generic members.
- **Leaves.** `webDappLeafPath('launch' | 'wallet-host' | 'inject' | 'verify' | 'stop' | 'cleanup')` names the CLI scripts.

```js
import { createWebDappAdapter } from '@farmslot/adapter-web/web-dapp';

const adapter = createWebDappAdapter({
  id: 'web-dapp',
  signerModule: '/path/to/signers.mjs', // exports { signers: { extension } }; omit for injected-only
  hooks: { actions },
});
```

## Resolver CLI

`browser-resolver.cjs` is also a command, for hosts that need a bounded child process (a hung CDP call can't stall the caller). Every command finishes within 120 s, exits 0 on success and 1 with the error message on stderr otherwise. Hosts can keep their own script path by calling `runCli(argv)`.

| command                                                                                                                                               | output                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve [--target <checkout>] [--launch-method spawn\|launch-services] [--display headless\|headful] [--recorded <file>] [--out <file>]... [--json]` | stdout: the browser path, or the resolution record with `--json`; each `--out` gets the record; stderr: one `[browser]` summary line |
| `load-unpacked --port <cdp> --path <dist> --profile <dir> [--expect-id <id>] [--open-url <url>] [--timeout-ms <ms>]`                                  | stdout: one JSON line `{ id, otherExtensions, owner }`                                                                               |
| `open-window --port <cdp> --url <url>`                                                                                                                | stdout: one JSON line `{ targetId }` for a new background window                                                                     |

## Maintenance rules

1. No product knowledge. A product's build locks, titles, fixtures, wallet state and signing policy stay in its harness and reach these modules as arguments.
2. Process and on-disk identity strings (runtime nonce flag, launch markers, probe cache path) are how a launched browser and its profile are recognised. Changing one makes browsers started under the old name unrecognised; call that out in the release notes.
3. Every CDP call has a deadline. Never add an unbounded wait.
4. Never steal focus. A headed launch restores the previous frontmost app; window activation goes by pid, not by app name. `placeWindow` moves a visible window without activating it (restoring a minimized one can).

## Local quality

```bash
yarn workspace @farmslot/adapter-web quality
```
