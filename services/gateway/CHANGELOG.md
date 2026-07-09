# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- fix(gateway): stream prepare output on the single `script.output` channel and record output lines by event name, so a run's persisted `lastOutput` no longer doubles every prepare log line.
- fix(gateway): recover the real signal exit code (129 SIGHUP / 143 SIGTERM) when a prepare tmux window is torn down externally instead of masking it as a generic exit 1, surface a "window killed externally" hint, and scope the pre-launch `prepare-*` sweep so it never SIGHUPs the current run's own windows.
- fix(gateway): drop stale step-owned decisions (`monitor_*` / `ci_*`) when replaying a run from an earlier step, so a prior generation's interactive handoff no longer re-blocks the reset run.
- feat(gateway): backlog archive/delete/restore support; the archivable-status set is now imported from `@farmslot/protocol` instead of a local duplicate.
- fix(gateway): thread the resolved install workspace into slot prepare/provision subprocesses. The prepare tmux window inherits the gateway env, which may not carry `FARMSLOT_WORKSPACE`; pack runway scripts then default the workspace to `$HOME/farmslot`, so a dev-farm slot wrote `.runway-resolved` and provision artifacts into the base install's workspace. `buildPrepareWrappedCommand` now exports the workspace root resolved via `resolveWorkspaceRoot` (mirroring the CLI's `resolveWorkspace` contract: `FARMSLOT_WORKSPACE` env → parent of the farmslot clone holding `state.json`). No-op when the env already sets the workspace; unset when no workspace resolves so the pack default still applies.
- feat(gateway): recipe-run artifact ingestion reads and validates `resolved-recipe.json` when present — the fully-composed recipe is checked in full (including flow-call resolution), while `recipe.json` stays envelope-only, so library-composed recipes are validated without rejecting them for unresolved `call.ref`s.
- feat(gateway): optional TLS listener. When `FARMSLOT_GATEWAY_TLS_CERT` + `FARMSLOT_GATEWAY_TLS_KEY` are set, the gateway also serves `wss://` and https `/health` on a second port (`FARMSLOT_GATEWAY_TLS_PORT`, default 7778) alongside the existing plaintext `ws://` port, so a hosted HTTPS Command Center can reach a local gateway again (Chrome 150 blocks `ws://` from https origins as mixed content). No cert configured leaves behaviour unchanged; a bad TLS config degrades to `ws://` with a teaching log instead of crashing the control plane.
- fix(gateway): retarget task-local `./mark` via `checklist-target.json` when nested-loop roles activate, so self-review and CI-fix progress marks the active checklist instead of worker `TASK.md`; restore worker target on replay and role completion.
- fix(gateway): rewrite the task-local `./mark` wrapper on every checklist-target sync so replayed or legacy task dirs pick up task-dir mode instead of stale explicit `TASK.md`/`SIGNAL.json` shims.
- fix(gateway): use structural try/finally restore for self-review-fix and CI-fix role bodies so new exit paths cannot skip worker checklist-target reset.
- fix(agent-runtime): drop legacy explicit-args mark surface; task-dir + manifest is the only supported invocation.
- fix(gateway): treat self-review progress `SELF-REVIEW-SIGNAL.json` (`status: running`) as non-terminal and require `review-feedback.md` before declaring review complete.
- fix: reset failed graph-linked backlog items to `ready` when their run is deleted or missing, clear stale run linkage on Mark ready, and retry graph enqueue when a prior completed scheduler ledger entry is stale.
- feat: validate `hooks.recipe_run` and live-rerun artifact packages against Recipe Protocol v1, and prefer typed `artifact-manifest.json` metadata for live recipe artifact rendering with legacy scanning only as fallback.
- feat: add the `artifact_available` prepare requirement. A profile can gate its cheap path on a project-declared `artifact_check` hook — a fast (seconds) probe reporting whether the profile's prebuilt artifact could be resolved. Exit 0 runs the profile; any non-zero exit walks the profile's declared fallback with the probe's last output line as the failure detail. A missing hook fails the requirement with `project has no artifact_check hook`. The run's work ref is threaded to the hook as `{{prepare_ref}}` (empty when the run has no work branch) and the project default branch as `{{prepare_default_ref}}`, so a probe can order its own resolution (work ref first, default ref fallback) and check the ref the run will run, not the slot's pre-checkout HEAD (selection precedes the git phase). `{{slot_id}}` is available for slot-scoped probe state. `expandHook`/`expandTemplate` gained an optional per-call `extraVars` map to carry them. Unknown requirement kinds keep failing `validatePrepareConfig` loudly, so an old gateway reading a config that declares `artifact_available` surfaces a teaching error rather than silently degrading.
- Consume the protocol-owned `RecipeQualityArtifact` validator and render worker task helper paths from `@farmslot/agent-runtime`.
- fix: local slots now show `[connect] Local slot on <machine>` instead of the misleading `[ssh]` messages during prepare — the SSH probe and labels are skipped when `isLocal` returns true.
- fix: deps phase now streams install output to the CLI in real time; previously the tail-poll ran but output was silently dropped because no `onOutput` callback was wired.
- feat: deps phase emits a `[deps] Still running… (Xm since last output)` heartbeat step every 30 s of silence so long yarn installs remain visible.
- fix: raise the local fixture-sync backstop from 60 s to 5 min (it sat on top of the real 55–60 s single-domain runtime, killing healthy prepares at exit 124), and, on timeout, teach the escape — elapsed vs limit, log path, the exact `farmslot slot prepare` re-run, and the working override (add `FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS` to the gateway `.env` and restart, since a CLI-side env prefix never reaches the running gateway).
- fix: restart recovery only skips prepare when nothing was terminated and the recorded prepare sub-steps show it completed its phases (a terminal `health` sub-step). Termination of a live in-flight prepare process is now reported precisely by `clearStalePrepareProcess`, so a health probe against artifacts a just-killed preflight was still refreshing no longer marks a half-prepared slot healthy and advances it to dispatch — recovery resets prepare and re-runs it instead.
- feat: the generated task-local `mark` wrapper resolves the published `@farmslot/agent-runtime` bin at run time via a resolution ladder (`FARMSLOT_AGENT_BIN` env override → `farmslot-agent` on `PATH` → recorded farmslot-install `mark-checklist-step.cjs` path → teaching error, exit 127), instead of hard-coding the path into the farmslot node install. Dev/farmslot-checkout slots (where the bin is not on `PATH`) keep the previous behaviour via the recorded-path rung.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.1 - 2026-07-03

- Expose gateway listen/bind metadata on `/health` and `gateway.status`, and warn in doctor when loopback-only bind blocks Companion LAN pairing.
- Add roadmap promotion draft persistence, backlog spec file access, and graph-linked dispatch activation support.
- Add experimental worker session history RPCs backed by runner transcript projection and feature capability reporting.

## 0.2.0 - 2026-07-03

- Fall back to the last pushed tmux pane snapshot (up to five minutes old) when live `tmux.panes` times out so slot worker inventory stays usable.
- Suppress false monitor nudges while workers are live or runs are blocked at publication human gate, including when prior nudge counts are saturated.
- Gate stuck violations on absent pane progress markers instead of treating any live process as active work.
- Stop treating Grok echoed task text after `❯` as a waiting-for-input composer prompt.
- Return a gateway-owned Doctor section catalog and support catalog-only or section-scoped reports for progressive clients.
- Harden gateway authentication rate-limit IP resolution by ignoring spoofable proxy headers unless explicitly trusted.
- Harden local slot file reads, writes, and HTTP file serving against symlink escapes outside the configured repo.

## 0.1.1 - 2026-07-02

- Expose optional releaseNotes on gateway.status from release-notes.json generated at release cut
