# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- feat: add the `artifact_available` prepare requirement. A profile can gate its cheap path on a project-declared `artifact_check` hook — a fast (seconds) probe reporting whether the profile's prebuilt artifact could be resolved. Exit 0 runs the profile; any non-zero exit walks the profile's declared fallback with the probe's last output line as the failure detail. A missing hook fails the requirement with `project has no artifact_check hook`. The run's work ref is threaded to the hook as `{{prepare_ref}}` (empty when the run has no work branch) and the project default branch as `{{prepare_default_ref}}`, so a probe can order its own resolution (work ref first, default ref fallback) and check the ref the run will run, not the slot's pre-checkout HEAD (selection precedes the git phase). `{{slot_id}}` is available for slot-scoped probe state. `expandHook`/`expandTemplate` gained an optional per-call `extraVars` map to carry them. Unknown requirement kinds keep failing `validatePrepareConfig` loudly, so an old gateway reading a config that declares `artifact_available` surfaces a teaching error rather than silently degrading.
- Consume the protocol-owned `RecipeQualityArtifact` validator and render worker task helper paths from `@farmslot/agent-runtime`.
- fix: local slots now show `[connect] Local slot on <machine>` instead of the misleading `[ssh]` messages during prepare — the SSH probe and labels are skipped when `isLocal` returns true.
- fix: deps phase now streams install output to the CLI in real time; previously the tail-poll ran but output was silently dropped because no `onOutput` callback was wired.
- feat: deps phase emits a `[deps] Still running… (Xm since last output)` heartbeat step every 30 s of silence so long yarn installs remain visible.
- fix: raise the local fixture-sync backstop from 60 s to 5 min (it sat on top of the real 55–60 s single-domain runtime, killing healthy prepares at exit 124), and, on timeout, teach the escape — elapsed vs limit, log path, the exact `farmslot slot prepare` re-run, and the working override (add `FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS` to the gateway `.env` and restart, since a CLI-side env prefix never reaches the running gateway).
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
