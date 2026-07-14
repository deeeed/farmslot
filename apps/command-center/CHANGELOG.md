# Changelog

All notable changes to `@farmslot/command-center` are tracked here.

## Unreleased

- fix: `yarn dev` co-launches the local `@farmslot/node` agent alongside gateway + UI, and `scripts/dev.sh` derives `GATEWAY_URL` from `GATEWAY_PORT` (with a fail-hard guard when the port is already bound), so dev machines no longer sit NODE DEGRADED.
- chore: recipe operational gate runs the hook-expansion tests from their new `@farmslot/slot-config` home.
- chore: prune the type-escape baseline entry for `packages/cli/src/gateway-client.ts` (file is now escape-free).

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.3.0 - 2026-07-13

- passive UI observation support to the Command Center recipe runner

## 0.2.1 - 2026-07-03

- Default `yarn farmdev` to `GATEWAY_HOST=0.0.0.0` when gateway token auth is configured.
- Reuse an existing same-origin Command Center CDP tab for validation navigation and resolve the default debug URL from the configured dev port.
- Add local debug launcher support for the configured Command Center dev port.

## 0.2.0 - 2026-07-03

- Add ALPHA maturity labels to under-tested Command Center surfaces, a version details modal, and progressive Doctor section refreshes.
- Show Command Center package version and git identity in the sidebar footer for demos.

## 0.1.1 - 2026-07-02

- Document manual release-cut workflow and wire fs-release-cut skill for operator release planning
