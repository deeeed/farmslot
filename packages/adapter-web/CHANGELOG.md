# Changelog

All notable changes to `@farmslot/adapter-web` are tracked here.

## Unreleased

- Add the package with the browser process and CDP layer moved from `@deeeed/metamask-harness`, unchanged in behaviour: `browser-resolver` (Chrome for Testing vs branded Chrome, probe cache, `runCli` entry), `browser-cdp` (deadline-bound browser CDP client, CDP-port ownership proof, `Extensions.loadUnpacked`, extension isolation), `chrome-args` (remote-debugging flags, runtime identity nonce, launch quarantine), `extension-id`, `macos-focus`, `playwright-cdp` (LavaMoat-safe page evaluation), `validation-process-ownership` and `validation-launch-supervisor`. Process and on-disk identity strings stay as they were so running browsers and profiles are still recognised.
