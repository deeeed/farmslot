# Changelog

All notable changes to `@farmslot/adapter-web` are tracked here.

## Unreleased

- `import { probeLaunch } from '@farmslot/adapter-web/browser-resolver'` (and the other 25 names after its first browser-cdp re-export) works from ESM: the re-exports are named bindings, which Node's CommonJS export detection can read. A package test checks that every library subpath gives ESM the names `require()` returns.
- Add the package with the browser process and CDP layer moved from `@deeeed/metamask-harness`, unchanged in behaviour: `browser-resolver` (Chrome for Testing vs branded Chrome, probe cache, `runCli` entry), `browser-cdp` (deadline-bound browser CDP client, CDP-port ownership proof, `Extensions.loadUnpacked`, extension isolation), `chrome-args` (remote-debugging flags, runtime identity nonce, launch quarantine), `extension-id`, `macos-focus`, `playwright-cdp` (LavaMoat-safe page evaluation), `validation-process-ownership` and `validation-launch-supervisor`. Process, on-disk and environment names are Farmslot's: `--farmslot-runtime-nonce=`, `.farmslot-detached-launch-unproven`, `/tmp/farmslot-browser-validation-<uid>`, `~/.cache/farmslot/browser-probe.json`, `farmslot-browser-probe-*`, `FARMSLOT_FOCUS_HOLD`, `FARMSLOT_FOCUS_BROWSER` and `FARMSLOT_VALIDATION_PORT_LEASE`; remediation hints name no product command.
- Add `page-target` (`selectPageTarget`: the page on an origin, preferring one whose URL carries a hash) and `browser-cdp.placeWindow` (move a target's window over CDP; a visible window moves without activating the browser).
