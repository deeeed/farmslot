# Changelog

## Unreleased

- Codex and ACP adapters send `plan.updated`: Codex `turn/plan/updated` and ACP `plan` updates as checklists, a completed Codex `plan` item as a proposal. They were dropped before. Codex threads start with its plan tool enabled (`tools.update_plan.enabled`), which the app-server otherwise leaves off.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.39.16 - 2026-11-01

- The native host removes a queued message on request (`cancelCommand`, and `native.worker.cancelCommand` under the worker's lease), persisting it as failed, never submitted and `cancelled` before it replies. A message already submitted, unknown, settled or of another lease is refused. Sessions on this host report `capabilities.cancelQueued`; a host started before the upgrade refuses the request as an unknown method.

## 0.39.15 - 2026-10-31

- A native session supervisor stops its host and exits when its home directory is removed, instead of running on with its process census (`ps` about ten times a second). Tests and smokes that delete their temp home no longer leak native host stacks.

## 0.39.14 - 2026-10-31

- `repinTask` retains a task checkout's changed provider in a new pin, replaces the task's selection and receipt, and points the generated marker at the new CLI. The previous pin keeps the original receipt (ADR-068 Amendment 8).

## 0.39.13 - 2026-10-31

- A Codex command's `tool.command` is the command line it ran, without the shell Codex wraps every command in, so clients show "Run git status" instead of "Run /bin/zsh -lc 'git status'". `tool.input` keeps the command as Codex sent it.

## 0.39.12 - 2026-10-31

- Native Claude, Codex and ACP adapters set `tool.kind`, `tool.command` and `tool.paths` on tool calls, so clients can show what a tool ran or changed without runner names (ADR-057 Amendment 8).
- `approval.resolved` records the response the host delivered for that request (`response`: the decision or answers), so clients can show what was approved or answered. A resolution the host did not deliver carries none (ADR-057 Amendment 7).
- Re-selecting a retained recipe attempt also moves the task acceptance ledger to that attempt's claims, so the gate no longer shows another execution's verdicts.
- Task instructions say to mark complete with criteria awaiting human review, so the run gate can collect that review instead of the worker waiting for it.

## 0.39.11 - 2026-10-30

- Refuse completion of recipe-backed tasks without a selected passing attempt, before review and publication.

## 0.39.10 - 2026-10-30

- Keep loaded native history while a healthy source change refreshes the read; report real observation failures separately.

## 0.39.9 - 2026-10-29

- Observe native host journal commits and shared account status without replaying commands; preserve structured missing-session errors.
- Ship the acceptance-contract TypeScript declaration in the public package.
- Support acknowledged acceptance derivation and revision-bound proof destinations for PR completion.

## 0.39.8 - 2026-10-29

- Align protocol 0.74.0 and adapter-sdk 0.25.2 in packaged task tooling.

## 0.39.7 - 2026-10-28

- Wait for Codex review folder consent before completing terminal startup; provisional startup frames no longer bypass Open restricted.

## 0.39.6 - 2026-10-28

- PR completion keeps linked criteria as evidence and checks worker-derived requirements without waiting for review.

## 0.39.5 - 2026-10-28

- Cache native process metadata for up to a minute during passive polling while keeping fresh identity checks for cleanup and controls.

## 0.39.4 - 2026-10-28

- Reduce retained task-tooling copy overhead without changing authenticated bytes, modes or links.

## 0.39.3 - 2026-10-27

- Refuse worker completion when either evidence manifest names a missing media file, before changing the checklist or signal.

## 0.39.2 - 2026-10-26

- Remove the local CI-parity worker step and its completion receipt requirement.

## 0.39.1 - 2026-10-25

- Include the acceptance-contract declaration so typed consumers can resolve the exported helper.

## 0.39.0 - 2026-10-25

- Derive PR-completion acceptance through acknowledged checklist children and consume gateway-confirmed proof destinations without changing frozen task contracts.

## 0.38.3 - 2026-10-24

- Reject invalid evidence manifests during progress marks with field-level errors, before checklist or signal updates.

## 0.38.2 - 2026-10-23

- Run managed native reviewers without approval prompts while preserving their sandbox write scope and worker safety policy.

## 0.38.1 - 2026-10-23

- Keep native review sessions alive after oversized runner events. Compact recorded diagnostic payloads while preserving protocol control messages and schema-bound results.

## 0.38.0 - 2026-10-23

- Align with `@farmslot/protocol` 0.65.0.

- Include the shared approval policy in self-review and paired review instructions.
- Reuse validated passing deterministic receipts for unchanged commands and inputs.

## 0.37.2 - 2026-10-22

- Read-only reviewers skip repository settings and hooks at startup while retaining the user's account configuration.

## 0.37.1 - 2026-10-22

- Saved-session resume accepts large retained-thread replies separately from the bounded event journal.
- Align with `@farmslot/protocol` 0.63.0.

## 0.37.0 - 2026-10-21

- Align with `@farmslot/protocol` 0.61.0, `@farmslot/adapter-sdk` 0.25.1.
- The shared Diff scope rule keeps correctness checks on the delta for the delta-scoped COLD review that runs when a warm reviewer session can't continue.

## 0.36.0 - 2026-10-20

- Align with `@farmslot/protocol` 0.60.0 and `@farmslot/adapter-sdk` 0.25.0.

## 0.35.0 - 2026-10-19

- A slow process census no longer stops the native host. The observer census waits up to 30 seconds for `ps` before failing closed; it waited 5 seconds before. On a loaded macwork (load 305, about 2000 processes), one slow `ps` had stopped the host and every native session it ran, five times between 10-15 and 10-19. Cleanup and startup-recovery reads keep their 5-second timeout (ADR-057 Amendment 3).
- Align with `@farmslot/protocol` 0.59.0 and `@farmslot/adapter-sdk` 0.24.0.

## 0.34.0 - 2026-10-19

- `./mark N` on a complete or no-change signal reruns a declared deterministic step and refreshes its receipt for the current tree without touching the box or the signal. Before, it rewrote the signal to `running`; clearing a stale `ci.local_check` receipt after a late commit no longer reopens the run. `deterministicChecks.execute` returns whether the step declared a check.
- Align with `@farmslot/protocol` 0.58.0 and `@farmslot/adapter-sdk` 0.23.0.

## 0.33.0 - 2026-10-19

- Align with `@farmslot/adapter-sdk` 0.22.0.

## 0.32.0 - 2026-10-19

- Completion refuses a criterion with proof mode `review` when the terminal contract has no `publicationReview`, and the task document tells the worker to give criteria about the change itself proof mode `review` (ADR-062 Amendment 18).
- Align with `@farmslot/protocol` 0.57.0 and `@farmslot/adapter-sdk` 0.21.0.

## 0.31.0 - 2026-10-19

- The task artifact contract check treats a `.webp` still in `evidence-manifest.json` as evidence media, so a missing one is reported.
- Align with `@farmslot/protocol` 0.56.0 and `@farmslot/adapter-sdk` 0.20.0.

## 0.30.0 - 2026-10-19

- Align with `@farmslot/adapter-sdk` 0.19.0.
- A runner event line over 1 MiB no longer stops the runner. The recorded copy keeps only the size of each base64 payload (an image or document the runner read), and only an event still over 1 MiB after that stops the runner, as `Native runner event exceeds 1 MiB` rather than `Native runner emitted invalid JSON`. Claude Code puts a Read image in its line twice, so any image over about 390 KB stopped native reviewers (TAT-4146 run 70bf7864, TAT-4145 run 8cff6e80).
- Native host startup recovers a host that was stopped while one of its sessions was still running and whose cleanup could not confirm the stop, for example after a `ps` census timeout. Recovery checks that the session's runner and recorded descendants are gone, and the new host marks the session failed. Before, that session's journal blocked every later host start.

## 0.29.5 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.5.

## 0.29.4 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.4.

## 0.29.3 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.3.

## 0.29.2 - 2026-10-18

- A QA task's acceptance ledger merges its case executions by criterion instead of keeping only the last case: a passing execution replaces the rows it proves and leaves the others, and each row names its case execution. The evidence review completion check binds each row to its own case package. Needs gateway 0.24.0 or later; deploy it first.
- Moves to `@farmslot/protocol` 0.55.0 and `@farmslot/adapter-sdk` 0.18.2.

## 0.29.1 - 2026-10-17

- Align with `@farmslot/adapter-sdk` 0.18.1 and `@farmslot/recipe-runner` 0.39.1 (network capture summaries redact credential-like path segments).

## 0.29.0 - 2026-10-17

- Native Claude and Codex adapters advertise and constrain the repair applicability result contract; the evidence review terminal check accepts a repair's retained rows only from the engine selection.
- Retain hosted task tooling under the expanded machine home, so a `~/` FARMSLOT_HOME no longer places task pins inside the product checkout.

## 0.28.0 - 2026-10-16

- Accept qualified parent proof references during PR-follow-up closeout while preserving explicit fresh-proof requirements.

## 0.27.0 - 2026-10-16

- Capture validated native review results on the completed command without treating streamed text as proof.

## 0.26.0 - 2026-10-16

- Produce hosted and authored tasks with retained node tooling, replay policy, metadata and independently retained workspace dependencies.
- Retain hoisted packages' workspace-provided peers without relaxing missing ordinary dependency checks.

## 0.25.4 - 2026-10-16

- Consume the recipe-runner 0.38.1 still-filename fix throughout the worker dependency set.

## 0.25.3 - 2026-10-16

- Align the worker dependency set with Protocol 0.50.0 and the qualified one-tap visual review readers.

## 0.25.2 - 2026-10-16

- Align the worker dependency set with Protocol 0.49.0 person-device sessions.

## 0.25.1 - 2026-10-15

- Preserve retained input directory names so installed dependency lookup keeps its original layout.

## 0.25.0 - 2026-10-15

- Retain task tooling and selected inputs with shared byte verification and frozen task callbacks.

## 0.24.0 - 2026-10-15

- Preserve native host census provenance after process exit and reconcile stopped hosts from retained kernel parent evidence without deleting journals or relaxing process-safety checks.
- Support explicit operator wait and resume marks without settling the worker or changing its checklist.

## 0.23.3 - 2026-10-15

- Align the published dependency set with the plain runtime and action contract names.

## 0.23.2 - 2026-10-15

- Disable native startup hooks for source-read-only workers before session initialization; keep ordinary conversation settings and source cleanup checks intact.
- Align the published dependency set with protocol 0.47.0 initial resource proof modes.

## 0.23.1 - 2026-10-15

- Inspect review account hook policy before task preparation, and isolate named Grok profiles from ambient home hooks and plugins while retaining same-account session resume.

## 0.23.0 - 2026-10-15

- Keep source and review diff identities stable across user Git settings; disable external diff and text conversion.
- Recover a stopped native host whose first process census failed before any session started, preserving the unmatched marker in quarantine and retaining all journals.

## 0.22.4 - 2026-10-15

- Align the installed dependency closure with protocol 0.45.0 and retained-run stack attachment.

## 0.22.3 - 2026-10-15

- Supply one minimal-diff policy and sensitive-path inventory for worker self-review, independent reviews and paired review packets.

## 0.22.2 - 2026-10-15

- Use the coordinated window screenshot engine dependency closure.

## 0.22.1 - 2026-10-15

- Recover stopped native hosts through fresh process verification and preserved cleanup receipts without resetting session journals.

## 0.22.0 - 2026-10-15

- Verify and execute provenance-bound branch maintenance with one shared guard and exact push leases.

## 0.21.3 - 2026-10-14

- Prepare native workspace decisions in the selected account home before farm reviews. Refuse Grok reviews with account hooks or unverifiable hook safety. Suppress repository startup automation, preserve Git-readable content and enforce source write restrictions.

## 0.21.2 - 2026-10-14

- Align task helpers with adapter-sdk 0.13.0 so recipe hosts use one SDK version.

## 0.21.1 - 2026-10-14

- Align runtime dependencies with recipe-runner 0.34.1 so installed adapters and recipe hosts use one engine version.

## 0.21.0 - 2026-10-14

- **BREAKING:** Make acceptance commands read-only, transfer only schema-2 engine claims, and refuse retained schema-1 verdicts for current completion.
- Resolve completion's evidence-manifest requirement through the selected engine attempt, matching artifact validation without a root copy or symlink.

## 0.20.1 - 2026-10-14

- Use the coordinated recipe release for content-based dependency readiness and engine-owned evidence manifests.

## 0.20.0 - 2026-10-14

- Show the supplied publication base and leased rebase instructions for branch-maintenance tasks.
- Generate recipe-owned acceptance instructions using supplied helper commands; retain authorized untestable review and completion checks.
- Resolve publication manifest requirements and media references inside the selected recipe attempt.
- Route valid unresolved engine claims to human review and refuse local schema-2 verdict overrides.

## 0.19.0 - 2026-10-13

- Validate the current retained recipe attempt selected by the task pointer while keeping earlier packages intact.
- Resolve declared execution-template sources through an attested source binding.
- Accept the reviewer feedback path binding in template lint while retaining the required feedback artifact check.

## 0.18.1 - 2026-10-12

- Update shared runtime dependencies for bounded recipe log observations.

## 0.18.0 - 2026-10-12

- Consume the shared acceptance contract and engine-derived claims; automatic ledgers permit only audited untestable overrides (ADR-062).
- Execute declared deterministic checklist commands through mark and refuse completion without current passing receipts and logs. Track submodule revisions too; require submodule changes to be committed before checking the parent repository.
- Use neutral review/review-fix task and terminal contracts across execution templates and checklist helpers.

- Successful task completion requires verdicts for every registered acceptance criterion, including older contracts without an acceptance opt-in. Missing or unreadable ledgers fail closed; no-change and review outcomes retain their existing contracts.

## 0.17.5 - 2026-10-11

- Align the protocol dependency with 0.37.0 so consumers resolve one copy.

## 0.17.4 - 2026-10-10

- Publish with protocol 0.36.0 so consumers share one dependency copy. No code change.

## 0.17.3 - 2026-10-10

- Publish with protocol 0.35.2 so consumers share one protocol copy. No code change.

## 0.17.2 - 2026-10-09

- The native worker launch digest ignores `GW_URL`, the gateway URL the gateway now injects. A native session saved before the node reported its URL, or reached through another URL for the same gateway, still resumes or parks. Any other launch setting change is still refused. A node built from main never reports its gateway URL, so a gateway with this change sends no `GW_URL` to it and digests match. Only a node built from an intermediate commit of this change, one that reports the URL with an older digest, could see a mismatch. The detached native host belongs to the node and is upgraded with it. A running host is reused (`native/client.ts`), so it must be restarted along with the node.
- The review launch handshake fails fast on any Codex selection screen it doesn't know (for example "Hooks need review", footer "enter confirm · esc skip") instead of waiting it out and reporting the launch as started.
- `scripts/review-terminal.cjs` answers Codex 0.162's "Folder access" screen for a review workspace with option 1, Open restricted, once per launch. Codex shows it on every launch in a folder declared untrusted and saves nothing when you choose it, so no config can skip it. Any other prompt, including Trust, or a changed screen fails the launch with the pane excerpt and no key is sent. The launch receipt carries `folderAccess: "restricted"` when it answered.
- Publish with protocol 0.35.1.

## 0.17.1 - 2026-10-09

- `scripts/acceptance-ledger.cjs` is also called by `@farmslot/recipe-cli` `run`, which records a recipe's proof targets with `setAcceptanceVerdict`; its header now names both callers. No behavior change.
- Publish with protocol 0.35.0 so consumers share one protocol copy.

## 0.17.0 - 2026-10-04

- Docs refer to the recipe runner package as `@farmslot/recipe-runner` (renamed from `@farmslot/recipe-harness`).
- Publish with protocol 0.34.0.

## 0.16.0 - 2026-10-02

- Retain bounded, redacted native crash diagnostics and kernel process identities. Persist busy steering and preserve cancelled receipts in their task history. Initialize existing task directories through the shared runtime producer.
- Publish with protocol 0.34.0 so consumers share the current task and runner contracts.

## 0.15.1 - 2026-09-29

- Publish with protocol 0.33.0 so consumers share the current task and runner contracts.

- Refuse review terminal reuse when its recorded runner or model differs from the launch request.

## 0.15.0 - 2026-09-28

- QA tasks complete with one HTML report and structured evidence, without requiring a duplicate Markdown report.

## 0.14.0 - 2026-09-27

- Resolve acceptance requirements per worker flow, so fix-bug tasks can require verdicts without blocking review runs.
- Bind terminal-review task marks to the launch attempt so repeated bootstrap by delegated workers preserves parent identity and checklist progress.
- Static Claude reviews initialize workspace trust with the launch environment and keep tool-runner scratch files writable inside the review sandbox.
- The published `dist/` no longer carries compiled test modules. The build config excludes `src/**/*.test.ts`, matching the other workspace packages; 0.13.0 shipped 17 of them (`.js`, `.d.ts` and both maps each) including the native durability and review-sandbox suites.

## 0.13.0 - 2026-09-20

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
- Enforcement is a per-project opt-in: `mark complete` passes `--require-acceptance-status` only when the resolved contract sets `worker_terminal.acceptance.require` and the handoff lists criteria. The artifact contract check then fails on a missing ledger, any criterion without a verdict, and `weak` or `missing` unless the contract also sets `acceptance.allowWeak`. Without the opt-in a project whose templates write no ledger completes exactly as before.
- The package `test` script ends with the acceptance-ledger end-to-end scenario on a real task directory.
- Transitional: the `--require-recipe-coverage-if-recipe` rule is unchanged, so farm templates keep writing `artifacts/recipe-coverage.md` until the Phase 4 template pass moves them onto `ac render`.
- `summarizeAcceptanceStatus` accepts the registered criteria and reports `unrecorded`; `acceptanceCriteriaView` pairs them with their verdicts. Both mirror `@farmslot/protocol`.

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
