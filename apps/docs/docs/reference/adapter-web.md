---
title: Web adapter
---

# Web adapter

`@farmslot/adapter-web` holds the browser side of a web platform: pick and launch an isolated Chromium, prove which process owns a CDP port, load an unpacked extension, select the page a recipe drives, and place windows without taking the operator's focus. It has no product knowledge. A harness passes its own build locks, titles and fixtures in as arguments.

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
| `macos-focus`                  | give the front back to the previous app after a headed launch, by pid                               |
| `playwright-cdp`               | evaluate in a page over a raw CDP session (safe where page globals are scuttled)                    |
| `validation-process-ownership` | find and stop the processes that own a slot profile                                                 |
| `validation-launch-supervisor` | supervise one validation launch: port lease, quarantine, cleanup                                    |

## Users

- The MetaMask harness (`@deeeed/metamask-harness`) builds its Extension and Terminal launches on these modules and vendors the package into the overlay it installs in a checkout.
- Command Center's recipe runner (`apps/command-center/scripts/agentic/run-recipe.mjs`) selects its page, finds the CDP browser pid and places the recording window with them.
