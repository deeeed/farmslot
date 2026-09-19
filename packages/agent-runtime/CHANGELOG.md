# Changelog

## Unreleased

- `mark N` on a step whose box and timing event are already recorded is a true no-op: it prints `already marked N` and leaves SIGNAL.json untouched instead of rewriting it with a new timestamp. A resume from `blocked`, a box checked by hand, `start` and every terminal mark still write.
- `mark sub` registers and drives child checklist units (ADR-060): a parent step delegates to its own checklist and signal under `subtasks/`, written only by `mark`.
  - `sub start <id> --step N --from <path|inline:text>` materializes `subtasks/<id>.md`: frontmatter stripped, `{{VAR}}` rendered from `inputs/handoff.json` plus `--var`, source and rendered digests recorded in `subtasks/index.json`.
  - `sub <id> <n> | complete [--report PATH] [--mark-last] | blocked --reason … | status` maintain the child pair.
  - While a child is unsettled the parent `mark N` for its step is refused, and parent `complete` / `no-change` (with the artifact-contract check) fail.
  - A child `complete` ticks the parent box with a normal parent timing event; a child `blocked` blocks the parent signal with `subtask <id>: <reason>` until the child resumes.
  - A child unit has no flow terminal contract: `--report` is its only artifact rule.
  - `--from template:<id>` is refused: resolving a catalog id needs project template sources the task-dir engine cannot read, so materialize the template first and pass its path.
  - The package `test` script ends with the `mark sub` end-to-end scenario, so CI runs it on a real task directory rather than unit tests alone.
- `farmslot-agent ac` records the acceptance-criteria ledger (ADR-060), the only writer of `artifacts/acceptance-status.json`.
  - `ac set <AC-N> <proven|weak|missing|untestable> [--proof-mode state|visual|mixed] [--evidence path]... [--recipe-node id]... [--note …]` refuses an id the handoff does not list, a verdict or proof mode outside the vocabulary, evidence that does not exist or escapes the task dir, and a hand-edited ledger; entries stay in handoff order.
  - `ac list` prints every criterion with its current verdict (`null` when unrecorded); `ac render` prints the coverage table ending with the `Overall recipe coverage:` line.
  - `task init` persists the criteria as `task.acceptanceCriteria` in `inputs/handoff.json` (new `--acceptance` flag, repeatable), which is where the positional `AC-<N>` ids come from. `TASK.md` rendering is unchanged.
  - `mark complete` passes `--require-acceptance-status` when the handoff lists criteria: the artifact contract check then fails on a missing ledger, any criterion without a verdict, and `weak` or `missing` unless the flow's terminal contract sets `acceptance.allowWeak`.
  - The package `test` script ends with the acceptance-ledger end-to-end scenario on a real task directory.
- `summarizeAcceptanceStatus` accepts the registered criteria and reports `unrecorded`; `acceptanceCriteriaView` pairs them with their verdicts. Both mirror `@farmslot/protocol`.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.12.0 - 2026-09-18

- `mark` records step names in SIGNAL.json (`step` and every `checklistTiming` event label) through the protocol's `checklistStepName`, the same name the gateway schema, Command Center and `mm-harness status --watch` show; its private rule kept the instruction tail.

## 0.11.0 - 2026-09-18

- `discoverTaskDirs(tasksRoot)` and `latestTaskDir(tasksRoot)` find the task directories `task init` (or a dispatch) wrote under a checkout's tasks root: the most recently signalled task wins, a checklist-only task is the fallback. For readers that want the task in progress in a checkout (`mm-harness status --watch` is the first consumer, in its next release) instead of each walking `temp/tasks` with its own layout assumptions.

## 0.10.0 - 2026-09-17

- Execution templates no longer declare a run mode. Selection matches flow, platform and domain; run mode stays an optional `task init` / `execution-template` input that matches project default rules. Conversation-driven templates opt out of the checklist requirement with `checklist: none` instead of relying on an `interactive` filename.
- Allow Cursor's Application Support directory and `/tmp/cursor-agent-persist-<uid>` in the review sandbox so `cursor-agent` can lock its chat and start.
- Retain exact terminal reviewer chat identities across managed worktrees.
- Share review filesystem protection between native and terminal launches while preserving task artifacts.
- Support managed review workers across native runners on macOS with source protection and exact model selection.
- Task documents no longer carry a `STATUS:` line; run state is the `mark` signal file (farmslot ADR-045) and the field had no reader.
- Recognize shared QA execution templates independently of static PR review.
- Run static reviewers with read-only source permissions and cancel native initialization safely.
- `writeTaskDir` drops the transition `writeChecklistManifest` option; a task dir never carries a default-valued `checklist-target.json`.
- Keep native worker state outside recyclable workspaces and support saved-conversation relocation across eligible sibling worktrees. Native sandboxed Git operations can write their repository metadata.
- Supervise leased worker sessions with duplicate-safe task delivery, retained conversation transfer, saved-session recovery, task-scoped history and verified process cleanup, including shutdown races where fresh OS checks confirm the processes have exited. Share asynchronous process scans and fail ownership checks when a census exceeds its deadline.
- Manage optional node-local native configuration profiles, retain native credential storage for default directories, and preserve session bindings across login rotation and recovery. Worker environments exclude node and gateway access credentials.
- Add standalone native conversations for Cursor and Grok through their installed runners and native login, with streaming, permissions, interruption and saved-session resume.

## 0.9.0 - 2026-09-13

- Add `task init` (library `taskInit` + `farmslot-agent task init`): the one producer of a task directory (`TASK.md`, `CHECKLIST.md`, `mark`, `inputs/handoff.json`, `inputs/worker-terminal-contract.json`) for control planes and harnesses alike. `handoff.json` now carries the selected checklist reference (`executionTemplate`) and, for Farmslot, `templateProvenance`; `inputs/execution-template.json` and `inputs/template-provenance.json` are no longer written. `checklist-target.json` is optional: absent means `CHECKLIST.md` + `SIGNAL.json`; `task init` never writes it, role switches do, and a control plane may write the default-valued file during a transition. The `mark` shim is one recorded command with a `FARMSLOT_MARK_CMD` override; `install-mark` is gone. `TASK.md` renders a `## Task` key only when it has a value (no more blank `PR_NUMBER:` / `TICKET_URL:` lines), and its checklist sentence no longer names Farmslot.
- Worker-template structure lint now rejects a flow template that still carries a `## Task` block or `TASK_DIR:` line (the task writer generates TASK.md); nested-loop role checklists may keep theirs via `lintWorkerTemplateStructure(content, { roleChecklist: true })`.
- Add idempotent native session creation with caller-reserved IDs, preserving live and terminal reservations across retries.
- Share native session and bounded workspace operations with execution nodes, with node identity pinned to each host and journal.
- Preserve native failed-turn diagnostics so clients can show login and provider errors.
- Add a supervised native session host with private local IPC, durable prompts and command receipts, event replay, and explicit saved-conversation recovery. Disable recovery for older Claude histories affected by documented native history-loss bugs.
- Include the proposed file changes from native tool events with permission requests so clients can display the action before approval.

## 0.8.1 - 2026-08-14

- fix(mark): generate and retain an opaque identity for each worker signal attempt.

## 0.8.0 - 2026-08-10

- fix(execution-templates): an explicit template id excluded only by the domain gate now fails naming the enabling source and domains; the participation gate is exported (`executionTemplateSourceParticipates`/`executionTemplateEntryParticipates`) as the single authority (MANUAL-000076).

## 0.7.0 - 2026-08-03

- Publish against `@farmslot/protocol` 0.18.0 so downstream recipe tooling resolves one protocol version.

## 0.6.0 - 2026-08-03

- fix(mark): step enumeration now skips informational sections (Acceptance Criteria, pre-merge, `<details>`) exactly like the gateway parsers — checkbox-formatted ACs no longer shift `mark N` onto the wrong box. Also tightens checkbox matching to `- [ ]` (no `* [ ]`), matching gateway behavior.

## 0.5.1 - 2026-08-02

- Align the published protocol dependency with 0.16.0 so downstream installs use one Recipe Protocol version.

## 0.5.0 - 2026-08-01

- **BREAKING:** Require structured run summaries when validating recipe artifact packages.
- fix(workers): resolve terminal artifact contracts by checklist so simultaneous worker, reviewer, review-fix, and CI-fix contexts cannot overwrite one shared contract.
- fix(workers): validate terminal artifact dispositions and keep nested review checklist progress scoped to the active worker context.
- feat(execution-templates): surface optional descriptions for selection guidance.

## 0.4.0 - 2026-07-26

- Add the shared execution-template catalog, selection, snapshot, and CLI boundary.

## 0.3.1 - 2026-07-24

- Validate retained recipe traces against their recipes and artifact attribution.

## 0.3.0 - 2026-07-24

- Fail artifact validation when the installed protocol rejects the canonical Recipe v1 envelope.

- **BREAKING:** Task artifact checks require Recipe v1 resolution metadata and exact reachable dependency documents.
- security: resolved dependency reads use digest-derived paths only.
- Validate authored recipes separately from their executed `artifacts/recipe-run` package.

- fix: worker-template lint now fails templates that omit `./mark` entirely when the resolved contract requires a terminal signal — previously such templates were skipped and produced no author-time issue (mark-less templates stay valid for `requireSignal: false` flows such as interactive pr-complete).
- fix: builtin `self-review` / `self-review-fix` contracts require the reviewer artifacts the templates actually produce (`artifacts/review-feedback.md` / `artifacts/report.md`) instead of `artifacts/learnings.md`, and the runtime flow-report mapping + heading inference cover both flows — unbreaks `yarn quality:worker-templates`, which was failing on main.
- fix: recognize CI-fix worker headings as the `ci-fix` flow and lint task-dir `mark --checklist ...` terminal commands, so `CI-FIX-SIGNAL.json` uses the intended report contract.
- build: declare `tsx` as a devDependency — the execution-template tests run through the workspace-scoped `run-tsx-tests.mjs` runner (`yarn exec tsx`), which cannot resolve an undeclared binary on a clean CI install.
- feat: add shared Markdown execution-template resolver/lint/new (ADR-049) with `farmslot-agent execution-template` CLI.
- refactor: rename the branch-maintenance flow `merge-main` → `update-branch` in the worker terminal contract, checklist marker, and task artifact contract.

## 0.2.0 - 2026-07-12

- fix: use workspace-linked `@farmslot/protocol` during local development so package builds cannot resolve a stale published sibling package.
- feat: the task-artifact contract check validates `artifacts/recipe.json` (envelope-only) and, when present, `artifacts/resolved-recipe.json` (in full, including flow-call resolution) against the shared Recipe Protocol v1 validator, with a local minimum-envelope fallback when `@farmslot/protocol` dist is not yet built.

## 0.1.1 - 2026-07-06

### Added

- Add `checklist-target.json` resolution to `mark-checklist-step.cjs` task-dir mode so `./mark` retargets to nested-loop checklists without per-role wrapper scripts.
- Add `--checklist` / `--signal` overrides on task-dir invocations; signal defaults from checklist basename when omitted.
- Add centralized nested-loop checklist/signal registry (`DEFAULT_CHECKLIST_TARGET_REGISTRY`, `CHECKLIST_TARGET_BY_AGENT_ROLE`) and path helpers in `checklist-target.cjs`.
- Add sync test ensuring `checklist-target.cjs` constants stay aligned with `@farmslot/protocol/checklist-target`.

### Changed

- Task-dir `./mark` now requires a valid `checklist-target.json`; missing or invalid manifests fail with a teaching error instead of silently falling back to worker `TASK.md`/`SIGNAL.json`.
- Remove the legacy explicit-args mark surface (`mark <task.md> <signal.json> <step>`); task-dir mode is the only supported invocation.

## 0.1.0 - 2026-07-06
