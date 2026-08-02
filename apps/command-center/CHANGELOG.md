# Changelog

All notable changes to `@farmslot/command-center` are tracked here.

## Unreleased

- feat(recipe): execute declared swipe, pan, drag, and long-press actions through the Command Center CDP transport.
- feat(inventory): shared work-inventory table shell + probe for Backlog/Roadmap/Work Graph/Runs migration (MANUAL-000074).
- fix(workflows): show active independent-review/fix work instead of a premature publish gate, reuse shared decision actions, turn Backlog into a sortable live-run-aware table with status counts, display flow types with the Runs palette, identify projects in Backlog/Roadmap/Run rows, and report the effective Grok model.
- feat: fleet Setup recipe evidence for per-node runner seats (bind label + CodexBar/native identity), including a dismiss-What's-new helper so CDP recipes can open the Setup modal reliably.
- chore: type-escape baseline pruned — `fleet/state.ts` no longer contains `as any` casts (RawSlot honest optionality).
- refactor: rename the branch-maintenance flow `merge-main` → `update-branch` in the orphan-run backfill flow map.
- chore: recipe operational gate runs the hook-expansion tests from their new `@farmslot/slot-config` home.
- chore: prune the type-escape baseline entry for `packages/cli/src/gateway-client.ts` (file is now escape-free).

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.4.0 - 2026-07-27

- fix(debug-chrome): reuse a CDP session only when the browser holding the profile also owns the listening socket at the probed address; refuse otherwise instead of driving an unrelated browser. `cdp.mjs` connects to that same address (`FARMSLOT_CDP_HOST`, default 127.0.0.1)
- feat(debug-chrome): add `--slot/--pool/--port/--profile/--url/--headless/--timeout/--help`, and key the default profile by port so slots with different CDP ports can run concurrently
- Align embedded recipes and actions with the strict Action Manifest v1 contract
- feat: run composable Recipe v1 documents with strict manifests, typed parameters, and library dependency resolution
- fix: pass only recipe-declared runtime context from Farmslot hooks
- fix: resolve adjacent task recipe libraries and propagate invocation trust into their dependencies
- fix: defer artifact creation and Chrome capture preparation until after recipe trust preflight
- fix: `yarn dev` co-launches the local `@farmslot/node` agent alongside gateway + UI, and `scripts/dev.sh` derives `GATEWAY_URL` from `GATEWAY_PORT` (with a fail-hard guard when the port is already bound), so dev machines no longer sit NODE DEGRADED

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
