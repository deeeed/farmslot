# Changelog

All notable changes to `@farmslot/command-center` are tracked here.

## Unreleased

- feat(probes): `cdp.mjs focus <hash>` fronts a tab and grants clipboard access so probes can exercise real copy buttons; add the `run-session-command` probe for the Run Detail runner-session panel.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.9.0 - 2026-08-21

- feat(dispatch): add reusable live proof and browser probes for sustained-pressure rejection, audited override, warm history, and the pressure dispatch-gate control (MANUAL-000109).

## 0.8.0 - 2026-08-20

- test(machine-pause): add the Command Center CDP proof probe for machine-scoped pause, release, residual, and restore controls.

## 0.7.0 - 2026-08-20

- feat(resources): add filter-aware core-normalized pressure trends, expandable process attribution, watch-state guidance, and selectable two-step idle cleanup previews with exact-target revalidation.
- fix(dev): make the root `yarn dev` command use the canonical Command Center `farmdev` launcher and update operator instructions.
- fix(copilot): update the live CDP probe for the terminal-first retained runtime, exact worker binding, compact controls, and removed legacy composer.
- feat(runtime-capabilities): add Gateway lifecycle smoke tools, a browser/CDP probe, and reusable Companion on-demand lifecycle proof.
- fix(copilot): keep contextual prompts and runner output in the canonical shared transcript, and normalize private terminal control sequences completely (MANUAL-000071).

## 0.6.0 - 2026-08-10

- chore(scripts): `cdp.mjs` gateway RPC timeout is configurable via `FARMSLOT_RPC_TIMEOUT_MS` (default unchanged) so long RPCs like `slot.prepare` can be driven from the helper (MANUAL-000085).
- test(probes): self-checking CDP probe for the execution-template picker dev-harness state (MANUAL-000076).
- fix(pairing): mint one device code per multi-address Companion QR instead of one independently redeemable code per address.
- fix(pairing): require an explicit existing-principal or new-service-principal authority before generating a Companion QR.
- test(review-recovery): add a read-only CDP probe for active and inactive operator-required banner rendering.
- chore: type-escape baseline pruned — `fleet/state.ts` no longer contains `as any` casts (RawSlot honest optionality).
- refactor: rename the branch-maintenance flow `merge-main` → `update-branch` in the orphan-run backfill flow map.
- chore: recipe operational gate runs the hook-expansion tests from their new `@farmslot/slot-config` home.
- chore: prune the type-escape baseline entry for `packages/cli/src/gateway-client.ts` (file is now escape-free).

## 0.5.0 - 2026-08-06

- feat(recipe): expose opt-in full-page `ui.capture_surface` evidence in the Command Center recipe runner
- feat(recipe): execute declared swipe, pan, drag, and long-press actions through the Command Center CDP transport
- feat(inventory): shared work-inventory table shell + probe for Backlog/Roadmap/Work Graph/Runs migration (MANUAL-000074)
- fix(workflows): show active independent-review/fix work instead of a premature publish gate, reuse shared decision actions, turn Backlog into a sortable live-run-aware table with status counts, display flow types with the Runs palette, identify projects in Backlog/Roadmap/Run rows, and report the effective Grok model
- feat: fleet Setup recipe evidence for per-node runner seats (bind label + CodexBar/native identity), including a dismiss-What's-new helper so CDP recipes can open the Setup modal reliably

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
