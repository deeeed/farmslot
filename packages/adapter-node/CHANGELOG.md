# Changelog

All notable changes to `@farmslot/adapter-node` are tracked here.

## Unreleased

- Add the headless Node platform adapter, moved from the metamask-harness `core` adapter. `createNodeAdapter(config)` builds a `PlatformAdapter` with no ports, dev server, logs or launch; the host supplies the id, detection, hints, wording, action set and overlay leaves. `nodeDependencyBlock` checks a Yarn PnP or node_modules install, its bins and runtime dependencies; `workspaceTsconfigEnv` points tsx at unbuilt workspace packages' `src`; `scripts/cleanup.sh --adapter <id>` removes the adapter's overlay.
