# Bash Decision-Core Inventory

Phase 4 of the CLI overhaul
(`.backlog/specs/farmslot-farm/2026-07-09-cli-tui-protocol-capability.md`):
which bash logic is a portable decision core vs. a side-effect edge, and where
the TypeScript twin already lives.

Survey of `scripts/*.sh` + `scripts/lib/*.sh` (41 scripts + 2 lib) and CLI shell-out
sites in `packages/cli/src`. Classifications from reading each file's head + key
functions, not names. Workspaces (`services/gateway`, `packages/protocol`,
`packages/cli`) live at the **repo root**, not under `apps/command-center`.

## Headline finding — the TS ports already exist

The gateway TypeScript already contains ports of the biggest bash decision cores.
The Phase 4 job for most "decision core" scripts is **delete the duplicated bash
logic and make the script a thin CLI/gateway caller**, not write a new port:

| Bash decision core                                                                                                                                               | Existing TS twin                                                                                                                                                                                                                     | Tested?                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `expand_slot_template` / `expand_hook` / `expand_platform_field` / `expand_dispatch_cmd` / `expand_recycle_cmd` / `render_fixture_template` (lib/slot-common.sh) | `services/gateway/src/core/hooks.ts` (`expandTemplate`, `expandHook`, `expandPlatformField`, `expandDispatchCmd`, `expandRecycleCmd`, `renderFixtureTemplate`) — header literally says "TypeScript port of lib/slot-common.sh"       | `core/hooks.test.ts` ✅      |
| `resolve_slot` / `load_slot_vars` / `resolve_remote_repo` / `get_project_field` / `load_project_config` / `resolveProjectTaskDirName` (lib/slot-common.sh)       | `services/gateway/src/core/config.ts` (`resolveSlot`, `loadSlotVars`, `resolveRemoteRepo`, `getProjectField`, `resolveProjectTaskDirName`, `isIgnoredPoolFile`)                                                                      | `core/config.test.ts` ✅     |
| `find-slot.sh` selection scoring (`is_free`, `cdp_live`, `sort_key`)                                                                                             | `services/gateway/src/methods/dispatch/slot-scoring.ts` (`isFreeSlot`, `isCdpLive`, penalty scoring)                                                                                                                                 | ❌ no `slot-scoring.test.ts` |
| `sync-fixtures.sh` `DOMAIN_NAME_RE`                                                                                                                              | `packages/protocol/src/contracts/runs.ts` (`DOMAIN_NAME_RE`, `isValidDomainName`) — comment marks bash as the "shell-side mirror"                                                                                                    | (protocol) ✅                |
| `pr-monitor.sh` first-match rule engine                                                                                                                          | `services/gateway/src/methods/pr.ts` (`computePRRecommendation`) — **rule sets diverge** (bash has MERGED/CLOSED/worker-active granularity pr.ts lacks)                                                                              | partial                      |
| `session-usage.sh` pricing + JSONL token aggregation                                                                                                             | `services/gateway/src/runtime/session-usage.ts` — **only wraps** the bash: `parseSessionUsageOutput` shells to `scripts/session-usage.sh <slot> total` and parses `key=value`. Pricing tables + JSONL parsing live **only in bash**. | wrapper only                 |

So `lib/slot-common.sh` is **already dual-maintained** against `hooks.ts` +
`config.ts`. Every `{{var}}` added to one must be added to the other by hand — a
standing drift hazard (e.g. hooks.ts already has `{safety_flags}`, `cursor_path`,
`grok_path` the bash `expand_dispatch_cmd` lacks).

---

## `scripts/lib/*.sh`

| File                          | Purpose                                                                                                                                 | Class                            | Port target / edge contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/slot-common.sh` (817L)   | Shared slot-lifecycle helpers: pool resolution, var loading, template/hook expansion, project config, plus SSH/tmux side-effect helpers | **MIXED — decision core + edge** | **Decision half is already ported** (hooks.ts + config.ts). Target: stop maintaining the bash copies of `expand_*`/`resolve_*`/`get_project_field`/`load_project_config`; expose them via a `farmslot internal expand-hook/resolve-slot` CLI verb and have scripts call it, deleting the python heredocs. **Edge half stays shell** with contract checks: `run_on`, `remote`, `kill_agent_in_session`, `cleanup_slot`, `teardown_slot_infra`, `update_farm_status`, `is_local` (ssh/tmux/git/rsync side-effects) |
| `lib/capture-helper.sh` (78L) | Wrapper around the external capture-helper binary for window capture                                                                    | **EDGE**                         | Keep shell. Contract: given pid+output path, emits frames to FIFO; assert exit code + non-empty output file                                                                                                                                                                                                                                                                                                                                                                                                      |

## `scripts/*.sh` — DECISION CORE (portable pure logic)

| Script                            | Purpose                                                                                                                                | Class                                 | Port target                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find-slot.sh` (155L)             | Pick best free slot for a project from `.farm-status.json` (inline python `is_free`/`cdp_live`/`sort_key`)                             | **DECISION CORE**                     | **Twin already exists** in `dispatch/slot-scoring.ts` — but bash re-implements it in an inline python heredoc. Port target: delete the heredoc, add `farmslot slot find --project <p> [--prefer-cdp]` that calls `isFreeSlot`/`isCdpLive`/scoring; **add the missing `slot-scoring.test.ts`** to lock the contract before deleting bash |
| `pr-monitor.sh` (198L)            | First-match rule engine mapping PR state → recommendation + suggested action command                                                   | **DECISION CORE**                     | Consolidate onto gateway `computePRRecommendation` (pr.ts). The bash rules are richer (MERGED/CLOSED/MERGE-CONFLICT/worker-active/action-needed); port those cases into `computePRRecommendation` with unit tests, then make `pr-monitor.sh` a formatter over `farmslot pr status --json`                                               |
| `session-usage.sh` (376L)         | Token/cost accounting: model pricing tables + JSONL transcript aggregation for a runner session (snapshot/report/total)                | **DECISION CORE**                     | Pricing tables + JSONL parsing exist **only here**; `runtime/session-usage.ts` merely shells out and parses the summary. Port the pricing map + `safe_json_lines`/totals into `session-usage.ts` (or `packages/protocol`) with unit tests over fixture transcripts; keep only session-file discovery as edge                            |
| `score-bug.sh` (123L)             | Load project scorer from project.json, run it, validate output JSON (difficulty enum, `one_shot_probability` ∈ [0,1], required fields) | **DECISION CORE (validation)**        | Port the output-contract validation to a protocol schema (`BugScore` zod/JSON-schema) + `validateBugScore()`; script keeps only the `eval` of the project scorer (edge)                                                                                                                                                                 |
| `write-runtime-context.sh` (197L) | Assemble the generic `temp/runtime/agentic-runtime.json` discovery contract from git/adb reads + slot vars                             | **DECISION CORE (contract assembly)** | Port the JSON-shape assembly into TS with a protocol type `AgenticRuntimeContext`; git/adb reads stay edge inputs                                                                                                                                                                                                                       |
| `validate-config.sh` (119L)       | Validate pool/project JSON against JSON-schemas (delegates to python `jsonschema`)                                                     | **DECISION CORE (validation)**        | Already have protocol validators (`validatePrepareConfig`, `validateScriptedConfig`, … in config.ts). Port target: `farmslot config validate <file>` reusing those; retire the python jsonschema path                                                                                                                                   |

## `scripts/*.sh` — MIXED (decision logic + external fetch/side-effects)

| Script                             | Purpose                                                                                                | Class                   | Port target / edge contract                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage-bug.sh` (388L)             | Fetch a bug from GitHub/Jira, parse it into `bug-input.json`, derive score key, run heuristic scoring  | **MIXED**               | Decision: AC/steps/screenshot/linked-PR **regex parsing**, ADF flattening, score-key derivation → port to a typed `parseBugInput(source, raw)` in protocol/CLI with unit tests. Edge: `gh issue view` / Jira `curl` fetch stay shell/CLI        |
| `batch-triage.sh` (362L)           | Bulk-fetch bugs (GitHub/Jira), loop `score_one`, filter by team/limit/since                            | **MIXED**               | Decision: filtering/dedup/team classification → typed. Edge: bulk `gh`/`curl` pagination                                                                                                                                                        |
| `grade-bug.sh` (289L)              | Call `claude` CLI for structured difficulty grade, validate, compute deterministic final score         | **MIXED**               | Decision: schema validation + **deterministic final-score computation** → port to TS with tests. Edge: `claude` CLI call                                                                                                                        |
| `validate-bug.sh` (169L)           | Ask `claude` (haiku) whether a bug is still valid given linked/merged PRs + recent commits             | **MIXED**               | Decision: still-valid JSON contract → typed. Edge: `claude` CLI + `git`/`gh` history reads                                                                                                                                                      |
| `sync-fixtures.sh` (369L)          | Apply project fixtures to a slot (domain validation + template render + ssh/scp/rsync copy w/ SSH mux) | **MIXED — mostly edge** | Decision: `DOMAIN_NAME_RE` (twin in protocol) + fixture-mapping resolution (twin `renderFixtureTemplate`) → reuse gateway. Edge (bulk): ssh=13/git=8/rsync=5/scp=2 remote copy stays shell; contract = fixtures present + rendered on slot repo |
| `post-fix.sh` (406L)               | Format + post a fix-report comment to a GitHub PR (reads slot artifacts via ssh/rsync, token usage)    | **MIXED — mostly edge** | Decision: comment-body formatting/video-size gating → could template in TS. Edge: `gh` post + ssh/rsync artifact read stays shell                                                                                                               |
| `post-review.sh` (549L)            | Format + post a review comment (review.md + line-comments.json) to a GitHub PR                         | **MIXED — mostly edge** | Same as post-fix: formatting is the only decision; `gh`/ssh are edge                                                                                                                                                                            |
| `download-github-images.sh` (115L) | Parse image URLs from a GitHub issue body, download each                                               | **MIXED (small)**       | Decision: image-URL regex extraction → reuse the same parser as triage-bug. Edge: `curl` download                                                                                                                                               |
| `download-jira-images.sh` (85L)    | Download image attachments from a Jira ticket via ADF/attachment API                                   | **MIXED (small)**       | Decision: attachment enumeration. Edge: `curl`                                                                                                                                                                                                  |
| `deploy-node.sh` (556L)            | Deploy/update a farmslot node to a fleet machine (rsync code, install launchd/systemd service)         | **MIXED — mostly edge** | Decision: `resolve_farmslot_deps` dependency-closure + launchd/systemd env XML/unit generation (portable). Edge (heavy): rsync=15/ssh, service install stays shell                                                                              |

## `scripts/*.sh` — EDGE (side-effect first, keep shell + contract checks)

| Script                       | Purpose                                                                                                                 | Class                       | Edge contract                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| `preflight-slot.sh` (311L)   | Verify a slot is dispatch-ready: fixtures synced, sim/emulator up, dev server on port, health check live (ssh/tmux/adb) | **EDGE**                    | Given slot id → returns pass/fail per check; assert exit code + per-check lines |
| `teardown-slot.sh` (59L)     | Gateway-free slot teardown via `teardown_slot_infra` hooks (works when gateway down)                                    | **EDGE**                    | Thin driver over lib; assert infra stopped                                      |
| `record-window.sh` (297L)    | Record a macOS window to MP4 (capture-helper + ffmpeg via FIFO, signal-safe)                                            | **EDGE**                    | Given pid → valid MP4 with moov atom on SIGTERM                                 |
| `gh-upload-asset.sh` (127L)  | Upload file(s) to a per-project artifacts repo via git push over SSH                                                    | **EDGE**                    | Returns raw.githubusercontent URL; assert push + URL                            |
| `backup-runs.sh` (66L)       | Copy tasks/ and runs/ into `.backups/` (rsync)                                                                          | **EDGE**                    | Filesystem copy                                                                 |
| `audit-remote-path.sh` (99L) | SSH every remote machine, probe for required binaries, print table, non-zero if missing                                 | **EDGE**                    | ssh `command -v` probe; assert table + exit code                                |
| `run-project-hook.sh` (52L)  | Expand `hooks.<name>` from project.json and run in slot repo (generic, no hardcoded hooks)                              | **EDGE (thin lib wrapper)** | Delegates to lib `expand_hook`; assert hook ran in repo                         |

## `scripts/*.sh` — WRAPPER / DELEGATOR (already thin CLI callers)

| Script                      | Purpose                                                                | Class                                       |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `check-slot.sh` (9L)        | `exec farmslot slot check <id>`                                        | **WRAPPER**                                 |
| `release-slot.sh` (13L)     | `exec farmslot slot release <id> …`                                    | **WRAPPER**                                 |
| `prepare-slot.sh` (18L)     | `exec farmslot` prepare (arg passthrough)                              | **WRAPPER**                                 |
| `dispatch.sh` (33L)         | Delegate to run CLI (mixed positional/optional arg parse)              | **WRAPPER**                                 |
| `pr-status.sh` (36L)        | Delegate to farmslot CLI (`--pr`/`--json`)                             | **WRAPPER**                                 |
| `farm-status.sh` (114L)     | Collect (delegates to gateway via CLI) + display/cached table          | **WRAPPER** (thin; display formatting only) |
| `setup-slot.sh` (43L)       | One-time machine bootstrap; delegates to project `setup/<platform>.sh` | **WRAPPER**                                 |
| `migrate-task-root.sh` (4L) | `exec node migrate-task-root.mjs`                                      | **WRAPPER**                                 |

## `scripts/*.sh` — DEV-ONLY / TEST-HARNESS

| Script                                   | Purpose                                                                | Class                    |
| ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `dev.sh` (86L)                           | Start command-center dev servers from `.env.ports`/`.env.local-auth`   | **DEV-ONLY**             |
| `completions.sh` (232L)                  | `farm` wrapper + bash/zsh tab completion                               | **DEV-ONLY**             |
| `e2e-tmux-runner-validate.sh` (208L)     | Live tmux E2E — canonical ADR-032 runner-driver proof (not unit tests) | **DEV-ONLY (test gate)** |
| `run-runner-observability-gate.sh` (41L) | Runner observability empirical gate (live tmux E2E + install probes)   | **DEV-ONLY (test gate)** |
| `validate-tmux-driver.sh` (2L)           | Alias → `e2e-tmux-runner-validate.sh`                                  | **DEV-ONLY (alias)**     |
| `validate-config.sh`                     | (also listed above as decision-core validation)                        | —                        |

---

## CLI shell-out sites — `packages/cli/src`

All are **already TypeScript**, so "port" is moot; the question is edge vs. embedded
decision logic. Verdict: **every shell-out is an edge, and each decision parsed from
command output is already contained in typed TS with a colocated `.test.ts`.** These
are the _model_ Phase 4 should copy for the bash decision cores, not a target.

| File                                 | Binaries shelled                               | Edge or decision-from-output     | Notes                                                                                                                        |
| ------------------------------------ | ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `gateway-tls.ts` (56L)               | none (reads cert files)                        | **EDGE** (filesystem)            | Resolves TLS material for `up`; pure fs, no shell                                                                            |
| `commands/pair.ts` (128L)            | `tailscale status --json`                      | **EDGE**                         | Parses tailnet JSON → LAN/Tailscale addresses; no reusable decision. `pair.test.ts` ✅                                       |
| `commands/scripted-runner.ts` (306L) | `spawn(command, shell)` project cmd            | **EDGE + typed decision**        | Timeout/exit-code → reason classification is decision, but already typed. `scripted-runner.test.ts` ✅                       |
| `commands/up.ts` (569L)              | `spawn` gateway, `open`, `ps -p … -o command=` | **EDGE + typed decision**        | Parses `ps` to confirm pid is THIS repo's node before respawn/kill — decision, typed. `up.test.ts` ✅                        |
| `commands/certs.ts` (105L)           | `mkcert -version/-install/-cert-file`          | **EDGE**                         | Cert issuance side-effect                                                                                                    |
| `onboarding/doctor.ts` (606L)        | `git`, `<bin> doctor --json`, `ps`             | **EDGE + typed decision**        | Update-needed = compare `origin/<branch>` refs; gateway-listen reachability. Decision typed. `doctor.test.ts` ✅             |
| `onboarding/workspace.ts` (107L)     | none                                           | **EDGE**                         | Hydrates `FARMSLOT_HOME` from state.json                                                                                     |
| `onboarding/uninstall.ts` (535L)     | `ps`, `tar`                                    | **EDGE + typed SAFETY decision** | Refuse-unsafe-path + workspace-containment + pid-ownership checks — real decision logic, fully typed. `uninstall.test.ts` ✅ |
| `onboarding/prereqs.ts` (216L)       | `command -v`, `<bin> --version`/auth-status    | **EDGE + typed decision**        | Version-string parse/compare + runner-auth probe, typed. `prereqs.test.ts` ✅                                                |
| `onboarding/add.ts` (809L)           | `git` clone/`check-ignore`/`remote get-url`    | **EDGE + typed decision**        | Pack-collision, operator-file-preservation, origin-mismatch decisions, typed. `add.test.ts` ✅                               |
| `onboarding/pack.ts` (226L)          | `git check-ignore`                             | **EDGE + typed decision**        | pack.json validation + content-hash idempotency, typed. `pack.test.ts` ✅                                                    |
| `onboarding/update.ts` (213L)        | `git` fetch/reset/rev-parse                    | **EDGE + typed decision**        | update = fetch+reset engine + pool schema migration, typed                                                                   |
| `onboarding/star-prompt.ts` (155L)   | `gh --version`/`auth status`/`repo star`       | **EDGE**                         | gh star side-effect; `star-prompt.test.ts` ✅                                                                                |

### CLI takeaway

No new typed ports are needed in the CLI. The pattern to replicate for the bash
decision cores is exactly what `uninstall.ts`/`add.ts`/`doctor.ts` already do:
**shell-out is a thin edge; the decision parsed from its output is a pure typed
function with a colocated unit test.**

---

## Ported in Phase 4

- **`find-slot.sh` decision core** → `packages/protocol/src/contracts/slot-selection.ts`
  (`slotUnavailableReason` / `cdpLive` / `slotSelectionScore` / `selectSlot`), unit-tested in
  `packages/protocol/test/slots/slot-selection.test.ts`, consumed by
  `farmslot fleet find-slot --project <p>` / `--slot <id>`. The bash
  script keeps working during coexistence; the TS module is canonical for operator
  slot picks. Dispatch-time scoring stays in
  `services/gateway/src/methods/dispatch/slot-scoring.ts` (richer criteria: branch
  affinity, host load, family identity).

## Follow-up port order (highest value first)

0. **(DONE 2026-07-14)** **Port the fixture-compose core** (variant/include
   selection + the render loop in `sync-fixtures.sh`) into `@farmslot/slot-config`
   behind one `farmslot internal` batch verb. Landed as
   `computeFixturePlan` (`packages/slot-config/src/fixtures.ts`) +
   `expandFixturePath` (`hooks.ts`), exposed via `farmslot internal fixture-plan`.
   Killed the compose/render python heredocs in `sync-fixtures.sh`: the template
   loop is now a single CLI pass (measured: the includes test's 3-template set
   dropped from ~12 `expand-template`/`render-fixture-template` node starts to 1;
   the largest packs' ~40 → 1). Fixed `scripts/tests/sync-fixtures-includes.test.sh`,
   which failed on `main` (an unresolved `{{domain}}` collapsed to `domains//…`
   instead of staying literal so the optional overlay skips quietly); locked by
   `packages/slot-config/src/fixtures.test.ts`. Directory fixtures (`fixtures.directories`)
   remain in bash (single rsync per dir; not a per-file CLI cost) — a follow-up.
1. **Kill the slot-common.sh ↔ hooks.ts/config.ts drift.** Expose the already-ported
   `expand*`/`resolve*` as `farmslot internal …` verbs; delete the python heredocs in
   `lib/slot-common.sh`, `sync-fixtures.sh`, `session-usage.sh` that re-derive
   slot/hook/template logic. Single source of truth = TS.
2. **Add `slot-scoring.test.ts`** for the gateway dispatch scoring core (currently
   untested).
3. **Port `session-usage.sh` pricing + JSONL aggregation** into `runtime/session-usage.ts`
   (currently the pricing map lives only in bash; TS just parses the summary).
4. **Reconcile `pr-monitor.sh` rules with `computePRRecommendation`** (pr.ts) — add the
   MERGED/CLOSED/worker-active cases with tests, make bash a pure formatter.
5. **Port bug-input parsing** (`triage-bug.sh`/`download-*-images.sh` share the same
   regex extraction) into one typed `parseBugInput` + `BugScore` schema; keep
   `gh`/`curl`/`claude` calls as edges.

## Retirement (Phase 4, 2026-07-13)

Port-then-retire executed per the caller audit. CI enforces the outcome:
`yarn quality:retired-scripts` fails on any path-shaped reference to a retired
script outside historical records (ADRs, archives, changelogs, this file).

Retired (deleted, callers repointed to the CLI): `release-slot.sh`,
`pr-status.sh`, `migrate-task-root.sh`, `validate-tmux-driver.sh`,
`find-slot.sh`, `dispatch.sh`, `monitor-slot.sh`, `show-slot.sh`,
`soft-refresh-slot.sh`, `reopen-slot-browser.sh`, `auto-refresh-slot.sh`.

Deprecated shims kept (project packs still print/document them):
`check-slot.sh` → `farmslot slot check`, `prepare-slot.sh` →
`farmslot slot prepare`. Retire once the pack READMEs/setup hints are
repointed in their own repos.

**Shim retirement re-audit (2026-07-14):** still blocked. The `metamask-farm`
pack repo continues to reference both shims — `check-slot.sh` in
`metamask-extension-farm`/`metamask-mobile-farm` READMEs, and `prepare-slot.sh`
in extension/mobile setup `Next:` echoes plus `metamask-core-farm` docs. The
pack is a separate repo (must not be edited from farmslot); the shims stay until
those repos repoint.

### scripts/ shrink follow-ups (MANUAL-000027, 2026-07-14)

- **Fixture-compose batch verb — DONE** (follow-up #0 above).
- **Slot helpers → CLI verbs — DONE** (MANUAL-000033, slice 2). `monitor-slot.sh`,
  `show-slot.sh`, `soft-refresh-slot.sh`, `reopen-slot-browser.sh`, and
  `auto-refresh-slot.sh` are ported to `farmslot slot monitor|show|soft-refresh|reopen|auto-refresh`
  (decision logic in `services/gateway/src/methods/slot/helpers.ts`; ssh/tmux/CDP
  side-effects run through `execOnSlot`/`execLocal`). Caller audit repointed
  `scripts/completions.sh` and `scripts/lib/farm-status-display.py`; the scripts are
  deleted and guarded by `yarn quality:retired-scripts`. Verbs validated live against
  the dev gateway (monitor report + show/soft-refresh/reopen/auto-refresh guard paths).
- **bug pipeline → `farmslot bug` — DONE** (MANUAL-000034, slice 3).
  `triage-bug.sh`, `score-bug.sh`, `grade-bug.sh`, `validate-bug.sh`,
  `batch-triage.sh`, and `download-{github,jira}-images.sh` are ported to
  `farmslot bug triage|score|grade|validate|batch` (image download folded into
  `bug triage`/`bug batch --download-images`). The commands are gateway-free
  (like `internal`): `gh`/`curl`/`claude`/the project scorer are spawned edges in
  the CLI, wired around the protocol cores. The existing `parseBugInput`,
  `validateBugScore`, `deriveScoreKey`, `extractImageUrls`, and `flattenAdf` are
  reused; the grade/validity/batch decision logic (LLM grade validation,
  deterministic final-score merge, validity defaults, and the GitHub batch
  post-filter) was ported to `contracts/bug-score.ts` (`normalizeLlmGrade`,
  `computeFinalScore`, `normalizeBugValidation`, `parseLlmJson`,
  `filterBatchIssues`) with node:test coverage, and the batch display table to
  `packages/cli/src/bug/display.ts`. Caller audit found no live in-repo callers
  (only `scripts/README.md` + the `scoring`/`project` schema descriptions, all
  repointed to the CLI; docs/ADR/changelog mentions are historical). The seven
  scripts + `lib/batch-triage-display.py` are deleted and guarded by
  `yarn quality:retired-scripts`. Validated live: `bug triage` against a real
  GitHub issue (fetch → parse → score-key → write score file), plus the
  score/grade skip paths and error envelopes; the `claude`-dependent grade/validity
  happy-paths have no configured project scorer in-repo and are covered by the
  bug-score unit tests.

Kept (no CLI parity): `setup-slot.sh` — the onboarding bootstrap invoked by
`farmslot project add` and every pack setup flow.

### Audit summary

| script                  | CLI replacement                       | live in-repo callers                        | external callers                           | verdict                                              |
| ----------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| check-slot.sh           | `farmslot slot check`                 | none                                        | 3 READMEs (projects + pack)                | **DEPRECATION-SHIM**                                 |
| release-slot.sh         | `farmslot slot release`               | farm-status.sh:98, pr-monitor.sh:93         | none                                       | **RETIRE** (repoint in-repo)                         |
| prepare-slot.sh         | `farmslot slot prepare`               | farm-status.sh:96                           | pack/project setup `Next:` echoes + docs   | **DEPRECATION-SHIM**                                 |
| pr-status.sh            | `farmslot pr list`/`pr status`        | completions.sh:40, pr-monitor.sh:47         | none                                       | **RETIRE** (repoint in-repo; keep --json shape)      |
| migrate-task-root.sh    | `node scripts/migrate-task-root.mjs`  | none                                        | none                                       | **RETIRE**                                           |
| validate-tmux-driver.sh | `scripts/e2e-tmux-runner-validate.sh` | none                                        | none                                       | **RETIRE**                                           |
| find-slot.sh            | `farmslot fleet find-slot`            | none                                        | none                                       | **RETIRE**                                           |
| dispatch.sh             | `farmslot run create`                 | none                                        | LEARNINGS docs only                        | **RETIRE** (repoint farm-status-display.py:367 hint) |
| setup-slot.sh           | none (no `slot setup` verb)           | onboarding add.ts:725 (every `project add`) | pack/project `setup/*.sh` dispatch targets | **KEEP**                                             |

Bug pipeline (MANUAL-000034, slice 3 — all retired):

| script                    | CLI replacement                         | live in-repo callers | external callers | verdict    |
| ------------------------- | --------------------------------------- | -------------------- | ---------------- | ---------- |
| triage-bug.sh             | `farmslot bug triage`                   | none                 | none             | **RETIRE** |
| score-bug.sh              | `farmslot bug score`                    | none                 | none             | **RETIRE** |
| grade-bug.sh              | `farmslot bug grade`                    | none                 | none             | **RETIRE** |
| validate-bug.sh           | `farmslot bug validate`                 | none                 | none             | **RETIRE** |
| batch-triage.sh           | `farmslot bug batch`                    | none                 | none             | **RETIRE** |
| download-github-images.sh | `farmslot bug triage --download-images` | none                 | none             | **RETIRE** |
| download-jira-images.sh   | `farmslot bug triage --download-images` | none                 | none             | **RETIRE** |

### Closeout (2026-07-15)

The shrink is complete: `scripts/*.sh` count **35 → 22**, every survivor justified in
[`scripts/README.md`](../../scripts/README.md) (keep-list table). Slices: fixture-plan
verb (PR #325), slot helper verbs (PR #327), bug command family (PR #328). The two
deprecation shims (`check-slot.sh`, `prepare-slot.sh`) carry dated notes and are
deletable once the referencing packs repoint to the CLI: the metamask pack
READMEs/docs plus the pack setup scripts and worker templates (audiolab,
echobridge, metamask) that still print `prepare-slot.sh` (pack-repo PRs).
The closeout itself retired one more: `post-fix.sh` had no tracked caller in
farmslot, the project packs, or the team repo (fix-report comments are posted by
the gateway run-completion path). Retired names are enforced deleted by
`scripts/quality/check-retired-scripts.mjs` (20 entries).
