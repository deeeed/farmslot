# Changelog

All notable changes to `@farmslot/cli` are tracked here.

## Unreleased

- feat: rename the team overlay to "domain" (`--domain`, pool `domain`) and add `farmslot domain ls` to list discovered domains
- feat: optional pool-level `session_prefix` — `project add` prefixes every registered slot's tmux session name (e.g. `dev-mm-1`), so dev/prod (or any multi-install) sessions on one machine never collide; unset reproduces today's unprefixed names
- feat: gateway profiles (ADR-036) — `farmslot gateway add/remove/list/use`, global `--gateway <name>`, machine-level `~/.farmslot/gateways.json`
- feat: `farmslot login` / `logout` / `auth status` against the existing gateway auth/pairing flow; doctor gains a per-profile Gateways section
- feat: `farmslot doctor`, `farmslot project add <pack>`, `farmslot update`, and `farmslot workspace init` — one-command onboarding from install.sh to validated farm slots (#27)
- feat: runner auth detection (missing / inactive / authenticated) gating install, workspace init, and doctor
- feat: `--json` output for doctor, project add, update, and workspace init (child output routed to stderr)
- Active-development baseline; add user-facing changes here before release or package publication.
