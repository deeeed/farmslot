# Changelog

All notable changes to `@farmslot/cli` are tracked here.

## Unreleased

- feat: add `farmslot roadmap request-promotion` for file-backed roadmap promotion review requests
- feat: rename the team overlay to "domain" (`--domain`, pool `domain`) and add `farmslot domain ls` to list discovered domains
- feat: gateway profiles (ADR-036) — `farmslot gateway add/remove/list/use`, global `--gateway <name>`, machine-level `~/.farmslot/gateways.json`
- feat: `farmslot login` / `logout` / `auth status` against the existing gateway auth/pairing flow; doctor gains a per-profile Gateways section
- feat: `farmslot doctor`, `farmslot project add <pack>`, `farmslot update`, and `farmslot workspace init` — one-command onboarding from install.sh to validated farm slots (#27)
- feat: runner auth detection (missing / inactive / authenticated) gating install, workspace init, and doctor
- feat: `--json` output for doctor, project add, update, and workspace init (child output routed to stderr)
- fix: `farmslot uninstall --purge` no longer crashes with `ENOTEMPTY` — tears down each slot's tmux session (exact-match `kill-session`, drops its watchman watch if any) before removing repos, and `rmSync` now retries on `ENOTEMPTY`/`EBUSY` as a safety net for any straggler write
- Active-development baseline; add user-facing changes here before release or package publication.
