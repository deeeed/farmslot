# Changelog

All notable changes to `@farmslot/cli` are tracked here.

## Unreleased

- feat: guided dispatch wizard — bare `farmslot dispatch` (and `farmslot run create` without `--ticket`/`--task`) on a TTY opens a @clack/prompts picker: project → backlog item or ticket/PR ref + flow → slot (auto-picked via the shared selection core, overridable) → confirm. Backlog route dispatches through the same markReady→enqueue→tick pipeline as `backlog dispatch`; machine mode refuses with teaching `DISPATCH_WIZARD_REQUIRES_TTY`.
- feat: `farmslot fleet status --watch` — live fleet table re-rendered from `fleet.updated` broadcast events over one authenticated connection (no polling); `q`/Ctrl+C exits; machine mode refuses with `WATCH_REQUIRES_TTY`.
- chore: TUI stack upgraded to current majors — Ink 7 + React 19 (React 19 types drop the global `JSX` namespace; ADR-050 amended).
- feat: `farmslot fleet find-slot --project <name>` / `--slot <id>` — TypeScript port of the `scripts/find-slot.sh` decision core (selection scoring + per-slot blocker reasons), envelope-emitting with discriminated teaching errors (`FLEET_STALE`, `NO_SLOT_AVAILABLE`, `SLOT_NOT_FOUND`, `SLOT_UNAVAILABLE`, `NO_PROJECT_SLOTS`).
- feat: `farmslot tui` — interactive Ink operator TUI over one authenticated gateway connection: fleet (stale banner, ghost suppression), backlog (dispatch / close-shipped), runs (gate resolution), recovery diagnosis, and live `slot prepare` progress; refreshes from `fleet.updated`/`backlog.updated`/`run.updated` events. Machine mode (`--json`/non-TTY) refuses with a teaching `TUI_REQUIRES_TTY` error. Architecture in ADR-050.
- feat: backlog operator loop — `farmslot backlog list|get|create|update|enqueue|dispatch|close-shipped` and `farmslot run list|get|gate|cancel|archive`, all envelope-emitting and RPC-only.
- feat: machine envelope — `fleet`, `slot`, `run`, `runs`, `dispatch`, and `doctor` emit `{schemaVersion, command, status, exitCode, data|error}` under `--json` or non-TTY stdout; error envelopes always carry `userAction`; documented at `docs/reference/cli-machine-envelope.md`.
- feat: fleet status shows a loud stale banner and never suggests prepare/dispatch from stale or ghost slots; gateway errors surface their `userAction` as a `Next:` line; failed commands exit non-zero; `fleet refresh` no longer probes machines twice.

- docs: `pickStreamOutput` describes prepare's single `script.output` channel; the slot stream filter already ignores every other event (comment/test only, no behavior change).
- feat: `farmslot recipe validate` accepts multiple recipe files (`recipes/*.recipe.json`) and exits non-zero if any is invalid, so it works as a PR gate. Adds `--library-source <name=path|path>` (repeatable) for a static resolve-check of library-composed recipes, and `--emit-resolved` to write each recipe's self-contained `resolved-recipe.json` (the full composition).
- feat: `farmslot recipe artifacts validate` checks the recipe document against Recipe Protocol v1 (validating `$schema` matches `schema_version` when present) and no longer double-counts recipe-document findings.
- fix: `farmslot project add` now seeds each slot repo with a baseline `agentic-runtime.json` during registration and preserves an existing prepared runtime context on re-add/repair, so slot metadata exists before preflight without clobbering selected simulator/device fields.
- feat: add `farmslot certs setup` — provisions a locally-trusted TLS cert (via mkcert) under `~/.farmslot/certs/` covering localhost and this machine's LAN address, so the gateway can serve `wss://` for the hosted HTTPS Command Center (teaching error if mkcert is missing).
- feat: `farmslot up` picks up the `certs setup` cert automatically — it starts the gateway with TLS and leads the hosted Command Center connect payload with the `wss://` candidate (keeping `ws://` as a fallback for http-origin use), restoring the hosted-CC → local-gateway path that Chrome 150 broke.
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
