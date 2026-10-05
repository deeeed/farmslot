# Changelog

All notable changes to `@farmslot/adapter-web` are tracked here.

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.0 - 2026-10-05

- Add `launch-browser` (`launchBrowser`: launch or release one isolated, detached, owned Chromium with an unpacked extension; `homeTabsToClose`) and `slot-title` (stamp the farm slot id into the extension home tab's title), moved from `@deeeed/metamask-harness`. Product knowledge is now passed in: the home page, its default title, the owner-root rule, a lock held for the launch, and the rerun command named in hints. `slot-title`'s `applyPersistentSlotTitle` takes `{ slotId, defaultTitle }`, `buildStampExpression(slotId, defaultTitle)` and `stampHomeTabsViaCdp({ homePage, defaultTitle, ... })` match it, and CDP stamping uses the global `WebSocket` (else `ws`), loaded only when it stamps.
- README: document the `browser-resolver.cjs` command (`resolve`, `load-unpacked`, `open-window`): arguments, output, exit codes and the 120 s bound.

## 0.1.0 - 2026-10-04

- Add the package with the browser process and CDP layer moved from `@deeeed/metamask-harness`, unchanged in behaviour: `browser-resolver` (Chrome for Testing vs branded Chrome, probe cache, `runCli` entry), `browser-cdp` (deadline-bound browser CDP client, CDP-port ownership proof, `Extensions.loadUnpacked`, extension isolation), `chrome-args` (remote-debugging flags, runtime identity nonce, launch quarantine), `extension-id`, `macos-focus`, `playwright-cdp` (LavaMoat-safe page evaluation), `validation-process-ownership` and `validation-launch-supervisor`. Process, on-disk and environment names are Farmslot's: `--farmslot-runtime-nonce=`, `.farmslot-detached-launch-unproven`, `/tmp/farmslot-browser-validation-<uid>`, `~/.cache/farmslot/browser-probe.json`, `farmslot-browser-probe-*`, `FARMSLOT_FOCUS_HOLD`, `FARMSLOT_FOCUS_BROWSER` and `FARMSLOT_VALIDATION_PORT_LEASE`; remediation hints name no product command.
- Add `page-target` (`selectPageTarget`: the page on an origin, preferring one whose URL carries a hash) and `browser-cdp.placeWindow` (move a target's window over CDP; a visible window moves without activating the browser).
- Every module's exports are named bindings Node's CommonJS export detection can read, so ESM named imports work (`import { probeLaunch } from '@farmslot/adapter-web/browser-resolver'`); a package test checks `import()` against `require()` for each export.
