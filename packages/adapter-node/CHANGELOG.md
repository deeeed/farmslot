# Changelog

All notable changes to `@farmslot/adapter-node` are tracked here.

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.3 - 2026-10-07

- Publish with adapter-sdk 0.7.0 and recipe-runner 0.26.0 so consumers share one adapter-sdk copy.

## 0.1.2 - 2026-10-07

- `checkoutWorkspacePackages` returns no packages for a target without a root `package.json` (it threw `ENOENT`), as it already skips a workspace directory without one. A Core-based plugin's fixture target runs inherited live scripts again.
- Publish with adapter-sdk 0.6.0 and recipe-runner 0.26.0.

## 0.1.1 - 2026-10-06

- Publish with adapter-sdk 0.5.1 and recipe-runner 0.26.0 so consumers share one recipe-runner copy.

## 0.1.0 - 2026-10-06

- Add the headless Node platform adapter, moved from the metamask-harness `core` adapter. `createNodeAdapter(config)` builds a `PlatformAdapter` with no ports, dev server, logs or launch; the host supplies the id, detection, hints, wording, action set and overlay leaves. `nodeDependencyBlock` checks a Yarn PnP or node_modules install, the bins the actions run (found through the host's `resolveBin`, so readiness asks what execution asks; no bin is required by default) and runtime dependencies, and `runtimeStatus` applies the same check, so doctor reports a checkout whose actions cannot run; `workspaceTsconfigEnv` points tsx at each workspace package's `src`, built or not, so a stale `dist` never runs, and `checkoutWorkspacePackages` takes the package list from the checkout's `workspaces`; `scripts/cleanup.sh --adapter <id>` removes the adapter's overlay.
- Publish with adapter-sdk 0.5.0 and recipe-runner 0.25.0.
