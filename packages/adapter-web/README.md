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
| `launch-browser`               | launch (or release) one isolated, detached, owned Chromium with an unpacked extension                          |
| `macos-focus`                  | capture the frontmost app before a headed launch and restore it if one of our browsers took it                 |
| `page-target`                  | pick the page on an origin, preferring one whose URL carries a hash                                            |
| `playwright-cdp`               | page evaluation over a raw CDP session (safe under LavaMoat scuttling)                                         |
| `slot-title`                   | prefix the extension home tab's title with the farm slot id, kept across the page's own title resets           |
| `validation-process-ownership` | find and stop the processes that own a slot profile                                                            |
| `validation-launch-supervisor` | supervised child for one validation launch: port lease, quarantine and cleanup                                 |

Sources are CommonJS (`src/*.cjs`) and ship as is; `yarn build` emits `.d.cts` declarations. Every library subpath can be `require`d or `import`ed with named imports, except `validation-launch-supervisor`: it is a child-process entry (it runs when loaded), so hosts `require.resolve` it and fork it.

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

## Resolver CLI

`browser-resolver.cjs` is also a command, for hosts that need a bounded child process (a hung CDP call can't stall the caller). Every command finishes within 120 s, exits 0 on success and 1 with the error message on stderr otherwise. Hosts can keep their own script path by calling `runCli(argv)`.

| command                                                                                                                                               | output                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve [--target <checkout>] [--launch-method spawn\|launch-services] [--display headless\|headful] [--recorded <file>] [--out <file>]... [--json]` | stdout: the browser path, or the resolution record with `--json`; each `--out` gets the record; stderr: one `[browser]` summary line |
| `load-unpacked --port <cdp> --path <dist> --profile <dir> [--expect-id <id>] [--open-url <url>] [--timeout-ms <ms>]`                                  | stdout: one JSON line `{ id, otherExtensions, owner }`                                                                               |
| `open-window --port <cdp> --url <url>`                                                                                                                | stdout: one JSON line `{ targetId }` for a new background window                                                                     |

## Maintenance rules

1. No product knowledge. A product's build locks, titles, fixtures and wallet state stay in its harness and reach these modules as arguments.
2. Process and on-disk identity strings (runtime nonce flag, launch markers, probe cache path) are how a launched browser and its profile are recognised. Changing one makes browsers started under the old name unrecognised; call that out in the release notes.
3. Every CDP call has a deadline. Never add an unbounded wait.
4. Never steal focus. A headed launch restores the previous frontmost app; window activation goes by pid, not by app name. `placeWindow` moves a visible window without activating it (restoring a minimized one can).

## Local quality

```bash
yarn workspace @farmslot/adapter-web quality
```
