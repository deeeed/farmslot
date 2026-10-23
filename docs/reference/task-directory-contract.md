# Task directory contract

One directory per run, the same shape whether Farmslot dispatched the worker or an engineer started the task from a skill. Farmslot defines the files; `@farmslot/agent-runtime` and any harness built on it consume them.

Review completion MUST wait for the reviewer's own terminal mark before archiving
its checklist and artifacts. A result file, idle runner or closed window alone
does not establish successful completion.

The shared harness checklist command MUST resolve explicit `--checklist` and
`--signal` overrides before preserving a terminal signal. To resume a cleared
blocker, run `checklist mark <task-dir> start`, then continue numbered marks. This
uses the existing runtime start verb, preserves checked boxes and resumes signal
progress under the launcher's attempt identity. Successful terminal verdicts remain protected.
On a complete or no-change signal, `checklist mark <task-dir> N` validates the
declared deterministic step under the receipt rules below without reopening the
signal; other numbered marks stay ignored.

Ticket intake preserves an explicit acceptance section, including an empty one. When none is supplied,
authored `AC1:` or `AC-1:` paragraphs outside fenced code populate the same
acceptance array in source order. Paragraph boundaries exclude unrelated prose.
Existing structured criteria remain authoritative. Generated TASK.md and
`inputs/handoff.json` MUST consume that same normalized array.

## Linked run tickets

`Run.linkedTicketRefs` stores operator-added Jira keys only. Metadata edits MUST
NOT rewrite `ticketData`, task files, package inputs, review state or evidence.
The shared reader unions the canonical Jira ref, `ticketData.jiraKey`, prefetched
`ticketData.linkedTickets`, ticket keys in description headings and acceptance
criterion prefixes, and these operator additions. Keys are uppercase and unique;
incidental references in description prose are not covered tickets.

Run list/detail in Command Center and Companion MUST show this same union and
search it through the shared run-list selection. Existing run and family summary
projections carry the covered-key union so a trimmed summary retains ticket lookup.
Removing an operator addition MUST NOT remove a key derived from frozen inputs.
A known Jira browse URL supplies links; a key without a resolved URL stays visible.
The run's recorded PR link remains available beside its tickets.
Run list rows MUST render one comma-separated line at the metadata text size,
without ticket pills or a separate label. The source ticket comes first and
appears once. A PR source is linked first, followed by covered tickets. The shared
`runLinkedTicketsView.references` owns this order and destinations. Long lines
scroll horizontally so additional tickets do not increase row height.
The existing metadata line also shows total wall time from `startedAt` or `createdAt`,
plus elapsed wall time from the running step's `startedAt`. Both apps MUST use
`runElapsedTimeView` and tick live labels at least once per minute. Terminal totals
freeze at `completedAt`, falling back to `statusChangedAt` or `updatedAt` on older records.

### Public surface

`@farmslot/protocol` exports the additive `Run.linkedTicketRefs` contract,
`normalizeRunLinkedTicketRefs`, `runLinkedTicketRefs`, `runLinkedTicketsView` and
`runElapsedTimeView`.
Command Center and Companion use the same reader and validation. Each platform
reuses one ticket renderer for run list and detail. The supported admin metadata
RPC `run.linkedTickets.set { runId, linkedTicketRefs }` replaces only the operator
additions, persists the run and broadcasts `run.updated`, following `run.tags.set`.
`RunMethods.setLinkedTickets` names it; CLI callers may use the existing generic
`farmslot rpc` entry. There is no new worker/harness hook, task input, workflow
action or wire version. The SDK addition requires a fresh minor package release.

## Run checklist progress

Command Center and Companion MUST retain the run pipeline and, when its current
step has structured checklist data, show a thinner bar beneath it with
`completedSteps/totalSteps` and `currentStep`. They MUST NOT derive totals from
pipeline segments or hint text. Without checklist data, no sub-bar is rendered;
the compact strip reserves its height so live updates do not move the run row.
A finished run or idle person gate MUST NOT display the previous review's checklist.

Both clients consume the `@farmslot/review-dispatch` run-checklist view model and
one renderer per platform for list and detail. They hydrate through existing
`task.progress` and follow `task.progress.updated`, matching the run, slot and
active checklist. Checklist or attempt changes invalidate cached progress.
Slot-free review workspaces use their existing empty slot id and run id.
These additive UI helpers are exported by `@farmslot/review-dispatch`; there are
no new CLI flags, persisted fields, harness requirements or wire version changes.

## Two documents, one checklist

The task document says **what** the work is. The execution checklist says **how** to do it, step by step. Only the checklist has steps.

| File           | Holds                                                                                                                                                                                                          | Steps counted? |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `TASK.md`      | Ticket block, description, acceptance criteria, screenshots, comments, PR comment summary (pr-complete), mode preamble, project addendum, mark instructions, pointers to `inputs/`, appended gateway contracts | no             |
| `CHECKLIST.md` | The selected execution template, placeholders expanded, nothing injected or appended                                                                                                                           | yes            |

Because the checklist carries no run data, a project can select a template from any catalog source and get the same bytes a standalone skill materializes for the same template id. The provenance digest proves it.

This is the only layout the task writer produces. One flow keeps its own pairing: lightweight interactive dev writes the operator-agreed plan into `CHECKLIST.md` and renders its template into `TASK.md`, because the plan there is decided live with the operator rather than selected from a catalog.

## Layout

```text
<task>/
  TASK.md                          task document (built by @farmslot/agent-runtime)
  CHECKLIST.md                     execution checklist (template, placeholders rendered, otherwise verbatim)
  mark                             shim: exec ${FARMSLOT_MARK_CMD:-<recorded command>} "$DIR" "$@"
  SIGNAL.json                      written only by mark
  checklist-target.json            role switches write it; absent = CHECKLIST.md + SIGNAL.json
  inputs/
    handoff.json                   the task record: identity, flow, task, report paths,
                                   executionTemplate (selected checklist + digests),
                                   templateProvenance (Farmslot only: repo revisions, selection source)
    worker-terminal-contract.json  artifacts required before a terminal mark
    bug-input.json                 ticket as fetched, comments included (when a ticket exists)
    …                              flow-specific inputs (planning context, PR comments, inherited context)
  assets/                          ticket attachments
  artifacts/                       worker output: reports, recipes, evidence; sandbox.json readiness record
    acceptance-status.json         acceptance-criteria ledger; written by `farmslot-agent ac` and recipe runs
  subtasks/                        child checklist units, written only by mark sub
    index.json                     registry of registered units (id, parent step, paths, source digests)
    <id>.md                        child checklist, materialized from a skill, template, or inline text
    <id>-SIGNAL.json               child signal (WorkerSignal + the parent link)
```

## Producers and consumers

One producer writes the shared layer on every surface: `taskInit` / `farmslot-agent task init` in `@farmslot/agent-runtime`. The gateway composes the same pieces (`renderTemplatePlaceholders`, `buildTaskDocument`, `writeTaskDir`) around its control-plane steps; project harnesses wrap the CLI with their defaults; recipe skills consume that shared task writer.

| File                                   | Producer                                                | Consumer                                                                                                             |
| -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `TASK.md`                              | task init; worker may append notes                      | worker, family follow-ups, review brief                                                                              |
| `CHECKLIST.md`                         | task init                                               | worker, `mark`, progress parser, Command Center progress                                                             |
| `mark`                                 | task init; command is a project value (`vars.mark_cmd`) | worker                                                                                                               |
| `checklist-target.json`                | role switch only                                        | `mark`, progress path resolution (default when absent)                                                               |
| `SIGNAL.json`                          | `mark` only                                             | run monitor, publication gate, closeout                                                                              |
| `inputs/handoff.json`                  | task init                                               | `handoff closeout`, learning packages, replay and eval, `farmslot run`                                               |
| `inputs/worker-terminal-contract.json` | task init from `project.json` `worker_terminal`         | `mark` terminal commands, artifact contract check, monitor hold                                                      |
| `inputs/inherited-acceptance.json`     | gateway preparation after parent proof qualification    | provisional PR-follow-up closeout; gateway revalidates the original parent independently                             |
| `inputs/bug-input.json`                | task init from the fetched ticket                       | `farmslot run`, review inputs                                                                                        |
| `subtasks/index.json`                  | `mark sub` only                                         | worker, gateway task watcher, review-workspace progress publisher, progress projection, view mirror                  |
| `subtasks/<id>.md`                     | `mark sub start` (materialized from the named source)   | worker, `mark sub`, progress projection, view mirror                                                                 |
| `subtasks/<id>-SIGNAL.json`            | `mark sub` only                                         | gateway task watcher, review-workspace progress publisher, progress projection, terminal contract check, view mirror |
| `artifacts/acceptance-status.json`     | `farmslot-agent ac`; a recipe run with a task dir       | terminal contract check, PR body / gate summary, run detail AC panel                                                 |
| `artifacts/sandbox.json`               | project harness preparation                             | worker, evidence package, Command Center (later)                                                                     |
| `artifacts/*`                          | worker                                                  | publication gate, review, retrospective (see worker artifacts by flow)                                               |

## Provenance

The selected checklist travels inside `inputs/handoff.json` as `executionTemplate`, identical in shape on both surfaces:

```json
{
  "executionTemplate": {
    "selectionReason": "configured-default",
    "id": "fix-bug/autonomous.mobile",
    "sourceId": "package:example-checklists",
    "flow": "fix-bug",
    "platforms": ["mobile", "ios", "android"],
    "labels": [],
    "relativePath": "fix-bug/autonomous.mobile.md",
    "sha256": "<source digest>",
    "renderedSha256": "<CHECKLIST.md digest>"
  }
}
```

`sha256` is the template source. `renderedSha256` is the checklist file as written. For a placeholder-free template they are equal, and equal to a skill-side materialization of the same id. Farmslot adds `templateProvenance` beside it (project repository revision, selection source, render time) for the run record; the reference is never stored twice. Task dirs written before 0.9 keep `inputs/template-provenance.json`; readers fall back to it for one release.

### Retained task tooling

`farmslot task init` uses the shared runtime producer. It retains the CLI distribution and selected provider, library and configuration bytes through the immutable installation mechanism. `inputs/recipe-binding.json` records the selection; `artifacts/harness-provenance.json` binds its bytes and the executable. The runtime owns this receipt and the installation pin manifest that verifies it. A provider is never recorded as the CLI. Full development workspaces refuse with `TASK_INSTALL_UNSUPPORTED`; task pinning uses the existing immutable CLI installation or a self-contained package install.

`farmslot task verify <task-dir> --json` checks the retained bytes before a wrapper invokes the recorded executable. `task mark` and `task closeout` use the retained provider's gates and policy. New frozen markers always enter that CLI; `FARMSLOT_MARK_CMD` cannot bypass its gates. Existing markers retain their recorded behavior. Product source and task recipes remain editable. Verification writes no files, and older receipts without `bindingIdentity` refuse without rewriting their original markers.

The root task commands consume `@farmslot/recipe-cli/harness`'s `projectTaskExecution`, `verifySelectedTask` and `withTaskProjectHost`. `TaskInitSpec.execution`, typed by `TaskExecutionInput` in `@farmslot/agent-runtime`, connects that selection to the one task producer. The receipt's `retainedInputs` lists original paths, retained paths and content digests. `pin` identifies the producer-owned installation pin. Verification compares its manifest with the task receipt before loading a recorded executable. The installation pins live under the selected `FARMSLOT_HOME`. The producer and verifier use that existing home selection; task data cannot choose another store or authorize another provider source.

The accepted [hosted initialization contract](project-recipe-contract.md#hosted-task-initialization), ADR-068 Amendment 5, applies this same producer on the execution node. The gateway supplies task data and mirrors its result; it does not replace the generated marker or task provenance. All affected active consumers migrate before activation, and the replaced producer is deleted. Existing tasks and receipts are not upgraded.

Provider retention includes its owning tooling workspace and declared installed dependency closure, independently of recipe-library discovery. The existing retained-input mappings and digests cover sibling imports and local dependency links without widening the selected recipe root or retaining the product checkout.

## Handoff metadata

`inputs/handoff.json` is the run's identity for closeout and learning packages:

| Field                     | Farmslot value                                                                              | Skill value                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `attemptId`               | run id                                                                                      | random UUID                                   |
| `surface`                 | `farmslot`                                                                                  | `skill`                                       |
| `project`                 | project name                                                                                | checkout basename                             |
| `repo`                    | `owner/name` from `repo_url` or `ci.repo`                                                   | `owner/name` from the git remote              |
| `domain`                  | effective run domain, when any                                                              | `--domain`, when any                          |
| `flow`                    | flow type                                                                                   | task kind                                     |
| `task`                    | title, `sourceKind` (`jira`, `github-issue`, `github-pr`, `text`), ticket, source URL       | title, `text` or `file`, ticket, ref          |
| `task.acceptanceCriteria` | the ticket's criteria, in order; position N is ledger id `AC-N`                             | `--acceptance` values, same ids               |
| `taskDocument`            | `TASK.md`                                                                                   | `TASK.md`                                     |
| `report`                  | the terminal contract's `complete.report` (`artifacts/pr-description.md` for dev / fix-bug) | `artifacts/pr-description.md` (dev / fix-bug) |
| `learnings`               | `artifacts/learnings.md`                                                                    | `artifacts/learnings.md`                      |

## Deterministic checklist checks

[ADR-064](../adr/064-deterministic-checklist-checks.md) defines task-owned command receipts before publication.

Its [CI decision check context amendment](../adr/064-deterministic-checklist-checks.md#amendment-1-2026-10-12-ci-decision-check-context)
owns the read-only gate/current comparison. The linked
[CI decision specification](ci-decision-check-context.md) defines retained provider
snapshots and refresh availability; those reads do not replace command receipts
or resolve publication gates.

### Public surface

`project.json` may set `ci.local_check` to a nonempty portable shell command. The built-in project uses `yarn ci:local`; the repository quality job calls the same script. Its guard list is shared, formatting is scoped to changed files when Git supplies a base, and tests requiring a tmux server remain CI-only.

PR-producing worker templates reference one `{{CI_PARITY_STEP}}` part. It materializes when a local command is configured. Projects without that field retain their existing checklist. A template can also declare a step explicitly:

```markdown
- [ ] CI parity [DETERMINISTIC: ci.local_check]
```

The shared task writer freezes each declaration under `inputs/worker-terminal-contract.json.deterministicChecks`, with `checklist`, `stepNumber`, `reference` and the resolved `command`. Task-init callers supply command references through their existing `vars`, including `vars['ci.local_check']`. Missing command references or malformed declarations refuse initialization. No new mark flags or top-level SDK functions are added.

Fix-role initialization MUST bind the engine's captured pre-fix commit to `FARMSLOT_CI_BASE_REF` in the frozen CI command. Retained delivery and replay MUST use that same commit. The Terminal pack consumes it for affected-test selection; worker instructions do not carry this binding. Missing legacy context retains the existing contribution-wide check.

### Mark and receipt rules

1. `./mark N` MUST reuse a receipt only when the frozen command, current publishable-input hash, successful completion and recorded log integrity still validate. Reuse MUST leave the receipt and log unchanged. Otherwise mark MUST execute the declared command itself before checking the box. This also applies after a complete signal. Execution uses the Git checkout containing the task, or the caller's target checkout when a standalone task is outside Git. The process inherits the configured environment and runs without a login shell.
2. On execution, mark MUST persist a running record first, then an immutable output log and a schema-version-1 completion receipt under `artifacts/deterministic-checks/<checklist>/<step>.json`. The receipt records command, reference, checklist, step, source-input hash, timestamps, exit code, signal and the relative log path/hash.
   Tracked submodules bind their checked-out commit, or their recorded gitlink commit while uninitialized. Uncommitted submodule work MUST fail closed with a commit-and-rerun hint because the parent repository publishes a gitlink, not those local files.
3. Only exit zero, unchanged publishable inputs and successful receipt persistence permit checking the box. Failure, interruption and missing configuration MUST refuse completion. Bulk/terminal marks and checklist skip flags do not waive these checks. Custom mark engines that cannot produce receipts cannot satisfy declared steps.
4. Publishable inputs are Git's tracked and nonignored untracked file inventory, paths, file permissions, file bytes or symlink targets, including tracked deletions. The task directory's owned inputs/outputs are excluded. Commit metadata is excluded, so committing identical checked content preserves a pass. Failure to identify the checkout or inputs fails closed.
5. The artifact checker MUST reject absent, failed, interrupted or stale receipts, changed commands, and missing/changed logs, independently of checkbox state. The active role's frozen declarations apply; role initialization freezes its own materialized checklist through the same writer.

Lightweight interactive development keeps the operator plan in `CHECKLIST.md`. Its generated CI-parity step is frozen in `TASK.md` and the shared part gives the existing `mark --checklist TASK.md N` invocation. The operator plan cannot waive its receipt.

### Publication and display

Package preparation and publication MUST validate receipts on the selected checkout. An older node checker that cannot return verified records fails closed. The package carries one optional `deterministicChecks` projection with command, state, exit code and log path; Command Center and Companion render it and open logs through their existing artifact viewers. After role cleanup, the last completed source-fix checklist supplies the final receipt. Read-only review checklists do not replace it. Restoring the parent MUST retain its initialized command declarations. Source or receipt changes after review require package refresh. Evidence-only refreshes of already published packages retain their archived source proof.

Receipts prevent skipped checks; they are not an attestation against a worker forging its task files. The existing trusted task initialization, artifact boundaries and publication authority still apply. Harnesses invoke the same mark/checker behavior and consume the same versioned records instead of implementing another checker.

## Outcome file: one name on both surfaces

dev and fix-bug workers finish with `artifacts/pr-description.md` whether Farmslot dispatched the run or an engineer ran the skill. It is the PR body in the repository's PR-template shape and carries the proof summary (what changed, root cause, validation, evidence paths). Most runs want a PR, and the file is usable before anyone decides to open one.

| Stage                                                | Farmslot                                                                                                | Skill                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Worker outcome (terminal contract `complete.report`) | `artifacts/pr-description.md`                                                                           | `artifacts/pr-description.md`                                                                                                             |
| Publication                                          | the gateway fills the evidence section from `evidence-manifest.json` and publishes after the human gate | the evidence packaging step adds the evidence images and artifact index into `pr-package/pr-desc.md`, then a PR is opened only on request |

`review-pr` writes `artifacts/report.md` (with its QA artifacts) on both surfaces; `no-change` writes `artifacts/no-change-report.md`. `inputs/handoff.json` `report` names the outcome file, so closeout and learning packages read the same file wherever the run happened.

## Layers: shared spec, control plane on top

Both surfaces produce the same task directory. Without the control plane (an engineer running the skill) the first two layers exist; with it (Farmslot) the last two are added beside them, and no shared file is renamed.

| Layer                     | Producer                                  | Files                                                                                                                                                                                                                                                                                                                                                                                                           | Surfaces                                                                                                   |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Worker outputs            | the agent following `CHECKLIST.md`        | outcome file (`pr-description.md`, `report.md`, `no-change-report.md`), `learnings.md`, `recipe.json`, `recipe-run/`, `recipe-coverage.md`, `recipe-quality.json`, `evidence-manifest.json`, `validation-summary.{json,md}`, before/after media, tool logs (`coverage.log`, `jest.log`, …); `subtasks/index.json`, `subtasks/<id>.md`, `subtasks/<id>-SIGNAL.json` through `mark sub`                           | both, same names                                                                                           |
| Harness readiness records | the project harness during preparation    | `sandbox.md`, `doctor-fix.json`, `status.json`, `launch-verify.txt`, `fixtures-set.txt`, `verify.json`; task-local provider lock                                                                                                                                                                                                                                                                                | skill today; the farm prepares the same environment in `preflight.sh` without leaving these records (open) |
| Gateway-owned             | the gateway, on the orchestrator copy     | `diff.txt`, `diff.txt.previous.*`, `diff-stat.json`, `session-metrics.json`, `workflow.mmd`, `pr-package.json`, `pr-package.md`, `publication-gate-<slug>.md` (slug: letters, digits, dashes), and per review round `<n>` (digits): `self-review-<n>/`, `self-review-<n>.json`, `self-review-<n>.md`, `independent-review-<n>/`, `independent-review-<n>.json`, `independent-review-<n>.md`, `review-loop-<n>/` | Farmslot only                                                                                              |
| Review-loop outputs       | reviewer roles on the slot, change ledger | `review-feedback.<context>.md`, `review-result.<context>.json`, `iteration-diff*.{json,txt}`                                                                                                                                                                                                                                                                                                                    | Farmslot only                                                                                              |

The gateway-owned row is exactly what `isGatewayOwnedArtifactMirrorEntry` in `services/gateway/src/core/artifact-copy-policy.ts` recognises: those files are never mirrored back from the slot and never count as worker evidence. Review-loop outputs are mirrored like worker files but belong to the control plane. Under `inputs/`, `runtime-capability-catalog.json` and the planning and inherited context files are Farmslot-only as well. A new gateway feature adds a name to one of these rows; it does not reuse a worker name.

Shared `inputs/` names: `bug-input.json` for the ticket as fetched and `assets/` for its attachments, on both surfaces. Task directory paths still differ (`temp/tasks/<flow>/<slug>-<stamp>` on the farm, `temp/tasks/recipe-cook/<stamp>-<slug>` for the skill); nothing reads the path, so it stays a naming difference.

## Simplification ledger

Kept current with the layout. Each row is something the layout still carries that a good default could remove. Rows leave when shipped or rejected. Shipped 2026-09-13: one task-dir producer; provenance folded into `handoff.json`; `ticket-comments.json` removed; `checklist-target.json` optional for readers. Shipped 2026-09-14: the gateway no longer writes the default-valued `checklist-target.json` (every node runs the 0.9 `mark` engine).

| Candidate                                                        | Today                                                                                                            | Simpler default                                                                 | State                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| two naming schemes for review outputs                            | `review-feedback.<context>.md` / `review-result.<context>.json` and `self-review-N.*` / `independent-review-N.*` | one scheme, one row in the layers table                                         | candidate                               |
| harness identity                                                 | PATH resolve through the pack's `recipe_runner_resolve_cmd` on the farm, task-local lock on the skill            | one preparation step both surfaces run, which also writes the readiness records | decision open                           |
| farm `defaults` pinning farm copies of dev / fix-bug / review-pr | three near-copies of the skill templates                                                                         | delete them so the catalog default (skills package) wins                        | deferred until the five-label inventory |
| task directory path                                              | `<flow>/<slug>-<stamp>` vs `recipe-cook/<stamp>-<slug>`                                                          | leave; nothing reads it                                                         | rejected                                |

## What travels to the slot

Dispatch copies `TASK.md`, then the task-root sidecars (`mark`, `CHECKLIST.md`, and `checklist-target.json` when present), then `assets/`, `inputs/`, `artifacts/`, and `subtasks/` as directories. Re-sync and warm-session handoff use the same list. At completion the gateway mirrors `artifacts/`, `TASK.md`, and `CHECKLIST.md` back beside the orchestrator copy as `*.worker`, and every file under `subtasks/` as `subtasks/<name>.worker` from a directory listing — child ids are chosen at registration, so there is no fixed name list.

A slot-free static review workspace (ADR-058) mirrors the same directory into its operator-visible `view/`, under the worker's own names rather than `*.worker`, so `subtasks/index.json`'s own relative paths still resolve there after the workspace is cleaned up.

The mirror travels one way. `*.worker` files are orchestrator-owned output written **from** the slot, so the outbound copy skips them: re-dispatching, nudging, or warm-handing off a task directory that already completed once must not put stale copies of the worker's own files back beside the live ones.

`subtasks/` is also the one directory the gateway creates on the slot without writing anything into it: both file-watch primitives observe a file through its parent directory, and the directory otherwise appears only with the first `mark sub start`, so the task watcher would never see a child registered mid-run. The registry, the child checklists, and the child signals stay `mark`-written. `artifacts/` is created the same way and for the same reason, so the acceptance-ledger watch has a directory to observe on a task dir that has not written one yet; the gateway writes nothing into it either.

## Project addendum

A project may ship `templates/task-document.md`. The writer renders it with the same placeholders as worker templates and inserts it into `TASK.md` before the checklist pointer. Use it for project tooling the worker needs before the first step (runner resolution, environment notes). It is not a checklist: checkboxes there are not counted.

## Boundaries

- The checklist never contains run data. Ticket text, acceptance criteria, and slot facts live in `TASK.md` and `inputs/`.
- `TASK.md` is never enumerated. A `- [ ]` inside an acceptance criterion cannot shift a step number.
- A ticked box is not proof. Proof is the recipe run, its evidence, and the artifacts the terminal contract requires.
- `SIGNAL.json` is written by `mark` only. Hand-written signals are rejected by the monitor.
- `subtasks/` is written by `mark sub` only, and a step may own one child unit for the life of the task directory. A child unit is observed, never spawned: registering one writes files and starts no process. A parent terminal mark is refused while any registered child is unsettled, by `mark` and again by the gateway's terminal check. Settled is `complete` or `done`: a `blocked` child is terminal for the run but keeps its step. The verbs and their refusals live in [Agent runtime](agent-runtime.md).
- A child unit is not a role switch. It never writes `checklist-target.json` and never changes the run's active task file, so a child may hang off `CHECKLIST.md` or off a role checklist such as `SELF-REVIEW.md`; the parent link names which. A child progress update is live only while its parent checklist is the active one, and `running` with no recent mark projects as `stale` — a projection only, never a status in the file.
- `artifacts/acceptance-status.json` is a task-namespace projection of the selected recipe engine's schema-2 ledger. The engine is the sole normal verdict authority; agent-runtime transfers its claims and never reduces or records manual verdicts. A QA task merges its case executions by claim id, and each row names its case execution ([QA case ledger](recorded-run-evidence.md#qa-case-ledger)). Writes and current successful completion reject schema 1. Retained schema-1 ledgers are display only with an explicit limitation; migration preserves original bytes and frozen decisions, never manufactures moments or task bindings. Recipe verdicts come from eligible executed expectations and required occurrences; action success alone is not proof, and visual claims require verified review. Successful completion requires a current verdict for every registered criterion even without an acceptance opt-in. PR follow-ups may consume qualified parent proof under [ADR-062](recorded-run-evidence.md#inherited-acceptance-for-pr-completion); otherwise missing ledgers or unreadable handoffs refuse. Weak or missing engine verdicts refuse unless the resolved contract sets `acceptance.allowWeak`. No-change and self-review keep their existing outcome contracts. `acceptance.require` cannot disable successful-completion enforcement. Per-flow `acceptance.allowWeak` overrides inherit unspecified keys. Standalone validation can request the same check with `--require-acceptance-status`. Current acceptance readers never derive relationships from manifest `covers` or substitute `recipe-coverage.md`.
- Schema-2 verdicts and task projections are engine-owned; `ac` is read-only and cannot override them. With a gateway-derived `claimReviewGate`, completion validates the selected package (for a QA case ledger, each row's case package) through the canonical SDK reader and can present unresolved verdicts at human review. Approval remains blocked. Only the verified `run.overrideClaim` operation records an untestable exception in the Run store; engine/task bytes stay unchanged. Without a human gate, completion keeps its existing refusal. [ADR-062 Amendment 4](recorded-run-evidence.md#verified-claim-overrides) defines authority and freshness.

- Lightweight interactive dev keeps its own pairing: `CHECKLIST.md` is the operator-agreed plan and `TASK.md` the context.

See also: [Agent runtime](agent-runtime.md), [Template variables](template-variables.md), and the worker artifacts by flow reference on the documentation site.
