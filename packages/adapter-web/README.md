# @farmslot/adapter-web

Web platform pieces for Farmslot recipes: pick and launch an isolated Chromium, prove which process owns a CDP port, load an unpacked extension, and give macOS focus back after a headed launch. A harness builds its `web` platform on these; the modules hold no product knowledge.

```js
const { resolveBrowser } = require('@farmslot/adapter-web/browser-resolver');
const { connectBrowserCdp, waitForCdpOwner } = require('@farmslot/adapter-web/browser-cdp');
const { activateMacAppByPid } = require('@farmslot/adapter-web/macos-focus');
```

Docs: https://farmslot.io/docs/reference/adapter-web

## Source layout

| module                         | owns                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `browser-resolver`             | Chrome for Testing vs branded Chrome, probe-launch and its cache, extension loading method; CLI entry          |
| `browser-cdp`                  | browser-level CDP client with deadlines, CDP-port ownership proof, `Extensions.loadUnpacked`, window placement |
| `chrome-args`                  | remote-debugging flags, isolated profile flags, runtime identity nonce, launch quarantine markers              |
| `extension-id`                 | Chromium extension id from a manifest key or an unpacked directory                                             |
| `macos-focus`                  | capture the frontmost app before a headed launch and restore it if one of our browsers took it                 |
| `page-target`                  | pick the page on an origin, preferring one whose URL carries a hash                                            |
| `playwright-cdp`               | page evaluation over a raw CDP session (safe under LavaMoat scuttling)                                         |
| `validation-process-ownership` | find and stop the processes that own a slot profile                                                            |
| `validation-launch-supervisor` | supervised child for one validation launch: port lease, quarantine and cleanup                                 |

Sources are CommonJS (`src/*.cjs`) and ship as is; `yarn build` emits `.d.cts` declarations.

## Maintenance rules

1. No product knowledge. A product's build locks, titles, fixtures and wallet state stay in its harness and reach these modules as arguments.
2. Process and on-disk identity strings (runtime nonce flag, launch markers, probe cache path) are contracts with running browsers and existing profiles. Change them only with a migration that still recognises the old values.
3. Every CDP call has a deadline. Never add an unbounded wait.
4. Never steal focus. A headed launch restores the previous frontmost app; window activation goes by pid, not by app name.

## Local quality

```bash
yarn workspace @farmslot/adapter-web quality
```
