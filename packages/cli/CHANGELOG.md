# Changelog

All notable changes to `@farmslot/cli` are tracked here.

## Unreleased

- feat: gateway profiles (ADR-036) — `farmslot gateway add/remove/list/use`, global `--gateway <name>`, machine-level `~/.farmslot/gateways.json`
- feat: `farmslot login` / `logout` / `auth status` against the existing gateway auth/pairing flow; doctor gains a per-profile Gateways section
- feat: `farmslot doctor`, `farmslot project add <pack>`, `farmslot update`, and `farmslot workspace init` — one-command onboarding from install.sh to validated farm slots (#27)
- feat: runner auth detection (missing / inactive / authenticated) gating install, workspace init, and doctor
- feat: `--json` output for doctor, project add, update, and workspace init (child output routed to stderr)
- fix: `farmslot completion zsh` output works whether autoloaded on `$fpath` or sourced — guards the invocation with `funcstack` (was erroring `_arguments:comparguments: can only be called from completion function` when sourced)
- Active-development baseline; add user-facing changes here before release or package publication.
