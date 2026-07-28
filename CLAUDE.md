# Farmslot — Agent Instructions

## Repo Structure

```
farmslot/
  scripts/           # Framework — project-agnostic lifecycle scripts
  projects/<name>/   # Project configs (nested git repos, gitignored)
    project.json     # Hooks, health checks, fixture mappings
    fixtures/        # Env templates, config files
    templates/       # Task templates (worker + orchestrator)
    setup/           # One-time machine bootstrap scripts (per-platform)
  pool/              # Machine registry (gitignored) — slots, ports, devices
  docs/              # Architecture docs
  tasks/             # Task files dispatched to agents (gitignored)
```

## Key Rules

### Never Amend Commits — HARD RULE

**Never use `git commit --amend`.** Always create new commits. Follow-up fixes get their own commit — history matters more than a clean graph.

### No Building Without Roadmap — HARD RULE

**STOP and ask before building anything not already in a PRD or roadmap.** Canonical roadmaps: [docs/ROADMAP.md](docs/ROADMAP.md) (whole-product) and [docs/ROADMAP-next.md](docs/ROADMAP-next.md) (near-term). If a task doesn't map to an existing milestone: (1) do NOT start coding, (2) capture it and propose where it belongs (new PRD entry, sub-item of existing milestone, or deferred), (3) get explicit approval before writing code. Bug fixes for code you just wrote are fine. New features, components, or protocol changes are not — unless already on a canonical roadmap.

### Validate UI Via CDP — HARD RULE

**Every UI change must be validated in the browser via CDP, not just TypeScript compilation.** Use the committed helpers — do NOT write throwaway `cdp-*.mjs` scripts:

1. Start dev server: `cd apps/command-center && yarn farmdev > /tmp/farmslot-dev.log 2>&1 &` (gateway auto-restarts on code changes via `tsx watch`; see **Dev Stack — Local CLI** below)
2. Launch Chrome with CDP: `bash apps/command-center/scripts/debug-chrome.sh` (idempotent — reuses session if listening). **Default CDP port is `9323`** (not 9222 — that's reserved for the example-browser flow; 4355 is reserved for another flow). Override via `FARMSLOT_CDP_PORT`.
3. Evaluate in-page via `node apps/command-center/scripts/cdp.mjs eval <route-hash> "<expr>"` or `--file probes/...js` for longer scripts.
4. Query gateway directly via `node apps/command-center/scripts/cdp.mjs gateway <method> '<params-json>'` to distinguish UI-render bugs from empty-data cases.

See `apps/command-center/CLAUDE.md` for the full protocol. If CDP is unreachable, say so explicitly — never claim the UI works based on typecheck alone.

### No Swallowed Exceptions — HARD RULE

**Never `catch` an exception just to ignore it or log-and-continue.** Empty `catch {}`, `catch (e) { console.log(e) }`, or try/catch wrappers that hide the real failure path are forbidden. If an error is genuinely expected and recoverable, handle it explicitly with a comment explaining why the recovery is correct. Otherwise let it throw — hidden exceptions cause the regressions we spend hours chasing. Same rule for Promises: no bare `.catch(() => {})`.

### Fix Root Cause, Not Symptoms — HARD RULE

**Before patching, decide: bandage or real fix?** State the diagnosis in one sentence, then pick the long-term fix by default. A bandage is only acceptable when Arthur explicitly asks for one or the real fix is out of scope for the current task — and when you ship a bandage, call it out as a bandage and note the follow-up needed. Signs you are bandaging: adding a null-check where the null is the bug, wrapping flaky code in try/catch, special-casing one caller, duplicating logic instead of fixing the shared helper, adding a flag to skip the broken path. **Do not ship regressions while "fixing" bugs.** If a fix changes behavior for other callers, trace them and verify before declaring done.

### No UI Value Injection — HARD RULE

**Never inject values directly into UI state (DOM, React/Redux/MobX store, signals, hooks) to "validate" a bug fix or feature.** Drive the real user flow via a recipe / Playwright / CDP-controlled interaction (`press`, `set_input`, `type_keypad`, real keystrokes) so the screenshot reflects the actual code path users hit. Direct injection bypasses validators, reducers, side-effects, and the very code under test — it manufactures false confidence and ships green screenshots over broken prod. If the only way to reach a state is injection, the fix is NOT validated; say so explicitly and do not claim success. Applies to TPSL inputs, order forms, balances, position state, modal field values — anything the user would normally type or compute. Setup-time fixture seeding at app launch (vault, preferences) is fine; mid-recipe state writes to fake an outcome are not.

### Review Every PR Before Merge — HARD RULE

**Every PR must get at least one `/review` round (independent code-reviewer agent) before being suggested for merge.** This applies to PRs opened by Claude — no self-approval, no "ready to merge" straight from a green CI. Fix every finding the review surfaces, including nits, unless explicitly waived. If review uncovers new issues, push a follow-up commit to the same branch and confirm typecheck + CDP still pass.

**Cross-model review is mandatory on top of the worker's own review pass.** After the implementing model reviews its diff, run at least one round of `/cross-review-orchestrator` (or equivalent) with a **different** model family — prefer Codex for speed, Claude when depth is needed. The cross-reviewer must inspect the same HEAD SHA; fix every blocking finding and nits before merge. Worker self-review alone is not sufficient.

### Never Commit Directly to `main` — HARD RULE

**Never commit or push to `main` on the farmslot root repo unless Arthur explicitly asks for it.** All farmslot changes go through a feature branch and a PR with review before merge.

Before **any** `git commit` or `git push`:

1. Confirm current branch is **not** `main` (`git branch --show-current`).
2. Be on a feature branch — `main` itself must never receive commits.

**Never stage, commit, or leave implementation diffs only on `main`.** Edit on a feature branch; open a PR. Nested project repos under `projects/<name>/` follow their own git workflow; this rule is for the farmslot monorepo root only.

**Manual changes: branch in place off `main` on the operator checkout — do NOT create a worktree unless Arthur explicitly asks.** When the operator checkout (`/Users/deeeed/dev/farmslot`) is on `main`, just branch directly and open the PR from it:

```bash
git checkout -b <type>/<slug>   # from the operator checkout on main
```

Commit on that branch and open the PR; never commit on `main` itself. `farmslot-wt/farmslot-*` are owned by dispatched runs — never hand-edit there. Only spin a dedicated `farmslot-worktrees/<slug>` worktree when Arthur **explicitly requests** one.

After creating a dedicated worktree, bootstrap its Yarn install before validation:

```bash
cd <new-worktree>
yarn install --immutable
```

Fresh worktrees do not share Yarn install state with the operator checkout, so typecheck/docs commands can fail until this is done.

For fast orchestration validation, prefer the checkout-local `scripted` runner workflow in `docs/operations/scripted-runner-validation.md`. Scenario mode requires `FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1`; command mode must use project-owned `scripted.commands` refs. Never validate with global `farmslot` or `npx farmslot`.

### Conventional Commits — HARD RULE

**Every PR title and commit message must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec.** Format: `<type>(<scope>)?: <subject>`.

- **Types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`.
- **Scope** (optional): area touched — e.g., `gateway`, `ui`, `protocol`, `skills`, `adr`, `roadmap`, `pool`, `scripts`.
- **Subject**: imperative, present tense, no trailing period.
- **Breaking changes**: append `!` after type/scope (e.g., `feat(protocol)!:`) and include a `BREAKING CHANGE:` footer.
- Apply to **PR titles** (squash-merge commit message) and **individual commits** on the branch.

Examples: `docs(adr): add ADR-026 self-improvement recursive loop`, `feat(ui): retrospective grading checklist`, `fix(gateway): prevent slot orphaning on restart`.

### Dev Stack — Local CLI and Gateway Autorestart — HARD RULE

**Do not invoke a globally installed `farmslot` binary during development.** PATH may resolve to an older machine-installed build with the wrong repo root, pool dir, or gateway URL — conflicting with the checkout you are editing.

Use workspace-local invocations from `apps/command-center`:

```bash
# Dev stack (gateway + UI) — preferred for the main operator tree
cd apps/command-center && yarn farmdev

# CLI against this checkout (not PATH farmslot)
cd apps/command-center && yarn farmslot <subcommand>

# Gateway RPC from scripts/agents (no CLI install)
node apps/command-center/scripts/cdp.mjs gateway <method> '<params-json>'
```

`yarn farmdev` runs `scripts/dev.sh`, which loads `.env.ports` / `.env.local-auth`, then `yarn dev` (gateway `tsx watch` + Vite UI). **Gateway source edits auto-restart** — do not manually kill/restart the gateway when `farmdev` is already running. Pool JSON edits under `pool/` are hot-reloaded (chokidar → fleet refresh) without a restart.

### Worktree slots — dispatch vs validation gateway — HARD RULE

For `macwork-ff-*` slots: **dispatch from operator main** (`~/dev/farmslot`, default gateway **7777** / UI **5174**). Never `yarn farmslot --url ws://localhost:8809 run create` for normal runs — `8808+` is the per-worktree **validation stack** (recipe/CDP UI) started by prepare `sandbox`, not the control plane. Git/tmux still execute in `farmslot-wt/farmslot-{n}`. See [docs/operations/worktree-operator-model.md](docs/operations/worktree-operator-model.md).

Worktree sandbox slots start their own stack via `sandbox-dev.sh` (also `tsx watch`). Only the main operator / `farmdev` tree should own the canonical gateway for CDP and `cdp.mjs gateway` probes unless a slot explicitly isolated ports.

### Command Center Typecheck — HARD RULE

When validating `apps/command-center/`, use:

```bash
cd apps/command-center && yarn typecheck
```

Do **not** use `tsc -b` for routine validation there. Some workspace packages do not emit into a safe build directory, so emitting builds can leak generated `.js`, `.d.ts`, and `.map` files into source paths.

### No `@deprecated` — Remove, Don't Mark

**Never add `@deprecated` annotations.** This is a dev product, not a public API. If something is unused, delete it. If it needs replacing, replace it. Deprecated markers create tech debt — just make the change.

### Docs Folder Hygiene

Keep `docs/` clean. Before adding or moving docs, read `docs/DOCS-GOVERNANCE.md`. Root `docs/` is only for canonical PRDs, roadmaps, governance, and implemented history; put stable technical detail in `docs/reference/`, approved supporting plans in `docs/plans/`, operations guidance in `docs/operations/`, and reader-facing website pages in `apps/docs/docs/`. Do not add one-off audits, generated dumps, private release checklists, scratch notes, or project/private evidence to `docs/`; delete stale/private planning material or keep it outside the public repo.

### No Project-Specific Logic in Scripts

**Never hardcode project-specific logic in `scripts/`.** All project behavior comes from `project.json` hooks. If you need a new project-specific command, add it as a hook — don't modify lifecycle scripts.

## Config Layer

**Pool JSON** (`pool/<machine>.json`) — owns machine config: SSH, ports, devices, slots, dispatch/recycle commands.

**Project JSON** (`projects/<name>/project.json`) — owns app config: hooks (preflight, health_check, recycle, etc.), health indicators, fixture mappings, platform-specific commands.

Pool overrides project when both define a command (e.g., `recycle_cmd` in pool takes priority over `hooks.recycle`).

## Hook Expansion

Hooks use `{{var}}` placeholders substituted from slot resource fields at runtime via `expand_hook()` in `scripts/lib/slot-common.sh` and `expandTemplate()` in `services/gateway/src/core/hooks.ts`:

```bash
# project.json
"hooks": { "health_check": "bash app-state.sh --port {{port}}" }

# At runtime, {{port}} is replaced with the slot's dev-server port from resources
```

Available variables (from slot resources): `{{port}}`, `{{metro_port}}`, `{{simulator}}`, `{{avd}}`, `{{adb_serial}}`, `{{cdp_port}}`, `{{headless}}`, `{{snapshot}}`.
Auto-injected: `{{platform}}`, `{{slot_id}}`, `{{runtime_dir}}`, `{{artifact_dir}}`, `{{farmslot_dir}}`.

## Project Repos (Nested Git)

`projects/<name>/` are **separate git repos** (gitignored from farmslot). Changes to templates, fixtures, project.json, or recipes won't show in `git status` from the farmslot root. Always `cd projects/<name>` to check status, diff, and commit project-level changes. Review changes from the project repo, not the parent.

## Testing Changes

```bash
# Fleet-wide status
bash scripts/farm-status.sh

# Deep-check a single slot
yarn farmslot slot check <slot-id>   # (from apps/command-center)

# Verify fixtures sync
bash scripts/sync-fixtures.sh --slot <slot-id>
```

## Architecture

See [docs/README.md](docs/README.md) and [docs/adr/](docs/adr/) for the full design: slot lifecycle, local vs remote execution, project config layer.

## Command Center (UI + Gateway)

When working on `apps/command-center/`, read [apps/command-center/CLAUDE.md](apps/command-center/CLAUDE.md) first. Key points:

- **Yarn workspaces monorepo**: `packages/{protocol,recipe-harness,theme,cli} + services/{gateway,node}` + `apps/command-center/ui`
- **Isolation first**: every feature must work with mock data before integration
- **Coexistence**: gateway is additive — never break existing bash scripts
- **OpenClaw reference**: copy patterns from `~/dev/openclaw/`, don't add as dependency
- **ADRs**: [docs/adr/](docs/adr/) — accepted architectural decisions
- **Roadmap**: [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/ROADMAP-next.md](docs/ROADMAP-next.md)

## Development Guidelines

- Scripts use `lib/slot-common.sh` for shared helpers — source it, don't duplicate logic
- `resolve_slot()` finds a slot across all pool JSONs
- `load_project_config()` reads the project.json for a slot's project
- `remote()` auto-detects local vs SSH execution
- Pool and project configs are gitignored — use `pool/example.json` and the README for reference
