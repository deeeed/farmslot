# Changelog

All notable changes to `@farmslot/adapter-node` are tracked here.

## Unreleased

- Add the headless Node platform adapter, moved from the metamask-harness `core` adapter. `createNodeAdapter(config)` builds a `PlatformAdapter` with no ports, dev server, logs or launch; the host supplies the id, detection, hints, wording, action set and overlay leaves. `nodeDependencyBlock` checks a Yarn PnP or node_modules install, the bins the actions run (found through the host's `resolveBin`, so readiness asks what execution asks; no bin is required by default) and runtime dependencies, and `runtimeStatus` applies the same check, so doctor reports a checkout whose actions cannot run; `workspaceTsconfigEnv` points tsx at each workspace package's `src`, built or not, so a stale `dist` never runs, and `checkoutWorkspacePackages` takes the package list from the checkout's `workspaces`; `scripts/cleanup.sh --adapter <id>` removes the adapter's overlay.
