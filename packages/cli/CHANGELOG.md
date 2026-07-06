# Changelog

All notable changes to `@farmslot/cli` are tracked here.

## Unreleased

- fix: `farmslot uninstall` no longer crashes with a raw `ENOTEMPTY` and half-purged state when a writer is active in the workspace. Each removal step is isolated — a failure records the path and the run continues (so the PATH symlink is always removed, never left dangling) — and before deleting, uninstall stops workspace-scoped watchman watches and sweeps leaked processes still holding the tree (e.g. a `tail -F …/metro.log`). `--purge` now removes the entire workspace dir including files farmslot did not create (pack installer markers), and re-running over a half-removed workspace completes cleanly. Anything that still cannot be removed is listed with a teaching escape and a non-zero exit instead of a stack trace.
- feat: add Recipe Protocol artifact-package validation helpers for `farmslot recipe artifacts validate`.
- feat: `farmslot doctor` shows where the resolved `capture-helper` binary came from — env overrides (`CAPTURE_HELPER_PATH` / `SITEED_CAPTURE_HELPER_BIN`) are surfaced as `(via <VAR>)` on both the passing and failing capture check, so "why is it using that binary?" self-answers.
- fix: `slot prepare` output no longer prints each line twice — CLI handler now filters to `script.output` events, ignoring the duplicate `slot.prepare.output` events emitted by the prepare stream.
- fix: `farmslot doctor` warns when the local gateway bind is loopback-only and blocks Companion LAN pairing.
- feat: add `farmslot roadmap request-promotion` for file-backed roadmap promotion review requests
- feat: rename the team overlay to "domain" (`--domain`, pool `domain`) and add `farmslot domain ls` to list discovered domains
- feat: gateway profiles (ADR-036) — `farmslot gateway add/remove/list/use`, global `--gateway <name>`, machine-level `~/.farmslot/gateways.json`
- feat: `farmslot login` / `logout` / `auth status` against the existing gateway auth/pairing flow; doctor gains a per-profile Gateways section
- feat: `farmslot doctor`, `farmslot project add <pack>`, `farmslot update`, and `farmslot workspace init` — one-command onboarding from install.sh to validated farm slots (#27)
- feat: runner auth detection (missing / inactive / authenticated) gating install, workspace init, and doctor
- feat: `--json` output for doctor, project add, update, and workspace init (child output routed to stderr)
- fix: `farmslot uninstall --purge` no longer crashes with `ENOTEMPTY` — tears down each slot's tmux session (exact-match `kill-session`, drops its watchman watch if any) before removing repos, and `rmSync` now retries on `ENOTEMPTY`/`EBUSY` as a safety net for any straggler write
- Active-development baseline; add user-facing changes here before release or package publication.
