---
title: Web adapter
---

# Web adapter

`@farmslot/adapter-web` holds the browser side of a web platform: pick and launch an isolated Chromium, prove which process owns a CDP port, load an unpacked extension, select the page a recipe drives, and move windows over CDP: a visible window moves without taking the operator's focus. It has no product knowledge. A harness passes its own build locks, titles and fixtures in as arguments.

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

| module                         | use it to                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `browser-resolver`             | choose Chrome for Testing or branded Chrome (probe-launched, cached) and how to load an extension   |
| `browser-cdp`                  | talk to the browser over CDP with deadlines, prove port ownership, load an extension, place windows |
| `page-target`                  | pick the page on an origin, preferring one whose URL carries a hash                                 |
| `chrome-args`                  | build remote-debugging and isolated-profile flags, runtime identity and launch quarantine markers   |
| `extension-id`                 | compute a Chromium extension id from a manifest key or unpacked directory                           |
| `launch-browser`               | launch or release one isolated, detached, owned Chromium with an unpacked extension                 |
| `macos-focus`                  | give the front back to the previous app after a headed launch, by pid                               |
| `playwright-cdp`               | evaluate in a page over a raw CDP session (safe where page globals are scuttled)                    |
| `slot-title`                   | prefix the extension home tab's title with the farm slot id, across the page's own title resets     |
| `validation-process-ownership` | find and stop the processes that own a slot profile                                                 |
| `validation-launch-supervisor` | supervise one validation launch: port lease, quarantine, cleanup                                    |

## Launching

`launchBrowser(options)` runs one launch end to end and returns `{ stopped: false, pid }` (or `{ stopped: true }` with `stopOnly`):

1. Refuse the CDP port if a process it can't prove is its own holds it. Proof is the exact `--user-data-dir`, or an extension path under the host's `extensionOwnerRoot`.
2. Stop the profile's previous owned browser and clear its singleton locks (`stopOnly` ends here).
3. Start the browser detached (macOS: Launch Services, in the background), load the extension, and keep one `homePage` tab.
4. Record `browser-resolution.json` and the runtime identity under `runtimeDir`, then give the front back if the browser took it.

The host passes what it knows about its product: `homePage`, `defaultTitle`, `extensionOwnerRoot`, `acquireRuntimeLock` (held for the whole launch) and the `rerunCommand` named in error hints.

## Resolver CLI

`node browser-resolver.cjs <command>` runs one bounded call (at most 120 s; exit 0, or 1 with the message on stderr):

| command         | arguments                                                                                                                                                              | stdout                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `resolve`       | `[--target <checkout>]` (default: cwd) `[--launch-method spawn\|launch-services]` `[--display headless\|headful]` `[--recorded <file>]` `[--out <file>]...` `[--json]` | the browser path, or the resolution record with `--json` |
| `load-unpacked` | `--port <cdp> --path <dist> --profile <dir>` `[--expect-id <id>]` `[--open-url <url>]` `[--timeout-ms <ms>]`                                                           | `{ id, otherExtensions, owner }`                         |
| `open-window`   | `--port <cdp> --url <url>`                                                                                                                                             | `{ targetId }` of a new background window                |

## Users

- The MetaMask harness (`@deeeed/metamask-harness`) builds its Extension and Terminal launches on these modules (its Extension launcher is `launchBrowser` with MetaMask's home page, title and build lock) and vendors the package into the overlay it installs in a checkout.
- Command Center's recipe runner (`apps/command-center/scripts/agentic/run-recipe.mjs`) selects its page, finds the CDP browser pid and places the recording window with them.
