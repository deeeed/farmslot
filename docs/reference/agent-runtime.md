# Agent Runtime

`@farmslot/agent-runtime` is the reusable task lifecycle layer for Farmslot-compatible agent runs. It can be used by full Farmslot dispatch, a project harness, or a skills-only workflow without Command Center, gateway, pools, or slots.

## Boundary

| Package                   | Owns                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`      | Pure contracts, types, validators, and shared constants.                                                                                                  |
| `@farmslot/recipe-runner` | Recipe graph execution and recipe artifact package writing.                                                                                               |
| `@farmslot/agent-runtime` | Task-local marking, `SIGNAL.json`, checklist timing, worker terminal contract resolution, closeout artifact checks, and recipe-quality artifact building. |
| `@farmslot/skills`        | Agent instructions and installer behavior; legacy runtime paths are shims.                                                                                |

## Native host cleanup recovery

[ADR-057 Amendment 1](../adr/057-structured-runner-transports.md#amendment-1-reconcile-stopped-native-hosts-2026-10-15)
owns recovery of a stopped host whose cleanup marker remains unresolved.

- The supervisor MUST hold the existing exclusive startup claim before checking
  or reclaiming an old host lock. A live supervisor or host MUST block recovery.
- An unresolved marker MUST identify the recorded host. Existing observations MUST
  identify its processes/groups. Recovery MUST obtain a successful fresh OS census and verify
  that the failed host's recorded processes and groups are stopped. Failed probes
  remain unknown. Live supervisor or host PIDs retain the existing startup refusal.
- If the first census failed before the host recorded any session, missing or empty
  observations MAY be quarantined after fresh and independent checks prove its
  supervisor, host and process group stopped. Every historical journal MUST still
  be complete, terminal and confirmed stopped. A journal from that unobserved host
  MUST refuse this fallback. Archive the original marker and verification facts in
  `cleanup-quarantine/` before reclaiming ownership; preserve all journal bytes.
- Every retained session journal MUST be complete and readable. Its latest state
  MUST be closed or failed, its process stop confirmed, and its runner group absent.
  Recorded detached descendants and their groups MUST also be absent.
  Malformed or torn records MUST refuse recovery, and so MUST active or unconfirmed
  records except as below.
- A session whose recorded runner belongs to the failed host MAY still be active or
  unconfirmed, because that host stopped before its cleanup could record the stop.
  Its runner, runner group and recorded descendants MUST then pass the same fresh
  absence checks. Recovery leaves the journal unchanged; the new host marks it failed.
- Journal process observations MUST come from the failed host's latest session
  generations, using the normal journal process projection. Older confirmed stops
  MUST NOT block because an unrelated process reused a historical PID. A different
  OS birth identity proves process reuse; a different living group leader proves
  group reuse. Orphaned groups and unreadable identities MUST remain blocked.
- Before reclaiming the host lock, the runtime MUST durably archive the original
  cleanup marker, journal hashes and verification facts under `cleanup-recoveries/`.
  It MUST preserve journal bytes, session/native IDs, generations, command outcomes,
  pending requests, owner/account bindings and run links. It MUST NOT signal a
  process, reset state, resume a runner or resend a command.
- A process census failure MUST fail every observer of the shared observer census,
  which stops the host when the observer is its supervisor. A slow census is a
  failure only once `ps` runs past 30 seconds
  ([ADR-057 Amendment 3](../adr/057-structured-runner-transports.md#amendment-3-a-slow-process-census-does-not-stop-the-native-host-2026-10-20));
  a failed `ps` or an observer's own failure still fails at once. Synchronous
  reads by session launch, runner stop, cleanup and startup recovery keep a
  5-second timeout.

### Public surface

Retry the existing native RPC with the same owner and execution node. The gateway
and node use `@farmslot/agent-runtime`'s existing `NativeSessionClient` startup;
the supervisor and shared process census own reconciliation. There is no new CLI
flag, RPC or harness configuration. A consuming runtime upgrade is required.

## Native reviewer completion turn

[ADR-057 Amendment 4](../adr/057-structured-runner-transports.md#amendment-4-one-completion-turn-for-an-unfinished-native-reviewer-2026-10-23)
owns this completion policy, accepted after paired policy review on 2026-10-23.

- The gateway MUST offer exactly one automatic completion turn when the current
  admitted native command has ended, the reviewer's own current signal is
  nonterminal, and its scoped result passes the existing artifact validator. Both
  completed and failed commands qualify. An interrupted command, pending native
  request, invalid artifact, stale signal or unconfirmed turn ending MUST refuse.
- The gateway MUST persist the completion instruction and stable command identity
  on the existing reviewer context before delivering it. A restart, repeated poll
  or lost acknowledgment MUST reconcile that same reservation and receipt. Neither
  an accepted command nor an uncertain receipt authorizes a second instruction.
- A live idle reviewer MUST receive the instruction through the existing native
  worker control boundary. A stopped process MUST have confirmed cleanup and
  verified saved-conversation resume before delivery. Owner, node, lease, launch
  settings, runner, model, account profile and saved runner session MUST match.
  Resume MAY establish a new native process generation; its ownership checks and
  durable recovery intent MUST still apply. No fresh-conversation fallback is allowed.
- The continuation MUST retain the original review admission, reviewed base/head,
  task, scoped checklist/signal and completed artifacts. It MUST NOT reset checklist
  progress, launch a new review round or repeat the reviewed diff. The instruction
  asks the reviewer to finish the existing checklist and terminal mark.
- After acceptance, monitoring and schema-bound visual-result collection MUST
  use the completion command's verified receipt and generation. The original
  failed command remains failed in history. A successful completion still requires
  a valid terminal signal and all existing result and visual validation.
- If that one continuation ends without a valid terminal signal, the gateway MUST
  fail the attempt with a clear completion-turn reason. The existing inactivity and
  review budgets remain active. Cancellation, pause, supersession, a released lease,
  changed task or foreign slot ownership MUST prevent delivery and adoption.
- Initial launch uncertainty, missing results and invalid terminal artifacts retain
  their current failure/reconciliation behavior. This policy does not authorize
  parsing runner output, changing providers or editing credentials.

### Public surface

The gateway consumes existing native worker send/resume operations and the durable
command journal. Existing reviewer instruction fields carry the reservation. There
is no new public RPC, CLI flag, SDK export, record field or harness setting, and no
runtime package or native-host update is required. WARM/COLD and round accounting
remain governed by ADR-063.

## Task Directory

A runtime-compatible task directory contains:

- `CHECKLIST.md` with `- [ ]` checklist items (the execution checklist) beside `TASK.md`, the task document that holds the ticket and acceptance criteria and is never enumerated (see [Task directory contract](task-directory-contract.md));
- `artifacts/` for reports, learnings, recipe outputs, and evidence;
- `SIGNAL.json`, written by `mark` only;
- optional `inputs/worker-terminal-contract.json` for project-specific terminal requirements;
- `mark`, a task-local executable shim written by `task init` (gateway or `farmslot-agent task init`).

Agents should use the task-local shim:

```bash
./mark start
./mark 1
./mark complete --mark-last
```

Do not hand-write `SIGNAL.json`. The runtime preserves pass-through fields, records checklist timing, verifies terminal artifacts, and writes the terminal status atomically.

## CLI

```bash
farmslot-agent task init <task-dir> --flow <flow> --platform <p> --template <id> --package-templates <catalog> --title "…" [--run-mode <mode>]
farmslot-agent mark <task-dir> complete --mark-last
farmslot-agent mark <task-dir> --checklist TASK.md complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
farmslot-agent contract resolve --flow fix-bug
farmslot-agent ac list
farmslot-agent ac render
```

`mark` takes a task directory, not individual file paths. Its first argument must be an existing directory or it exits with a usage error. It marks `CHECKLIST.md`, falling back to `TASK.md`, and writes `SIGNAL.json` unless a role switch supplies `checklist-target.json`. `--checklist` selects a checklist explicitly and derives its role-scoped signal filename.

## Child checklist units

A checklist step can delegate its work to a child unit: a checklist plus signal
under `subtasks/`, written only by `mark sub` (ADR-060). Farmslot materializes
files and reads signals; it never spawns the child, so who executes the rows —
the same session, a runner sub-agent, a harness script — is outside the contract.

```bash
./mark sub start <id> --step N --from <path|inline:<text>> [--var KEY=VALUE ...]
./mark sub <id> <n>
./mark sub <id> complete [--report <artifact>] [--mark-last]
./mark sub <id> blocked --reason "..."
./mark sub <id> status                      # the child projection as JSON
```

`--from` takes a path to a checklist-shaped file (a skill body is the usual one;
see the authoring rule in `@farmslot/skills`) or `inline:<text>`. The source is
rendered with the task's variables, its digest is recorded before rendering and
the written child's after, and a source with no enumerable row, or with numbered
labels that disagree with their positions, is refused. `template:<id>` catalog
resolution is refused: resolving a catalog id needs the project's template
sources, which a task-dir-local engine cannot read, so materialize the template
first and pass its path.

Ownership rules, all enforced by `mark`:

- A step owns one child for the life of the task directory. Registering on a step
  that already has one, or on a checked box, is refused.
- While the child is unsettled, `mark N` for that step is refused with a pointer
  to the child. Settled means `complete` or `done`; a `blocked` child is terminal
  for the run yet keeps its step, so the parent still cannot mark past it.
- `sub <id> complete` ticks the parent box and appends the parent timing event a
  normal parent mark would, then a later `mark N` on that step is a no-op.
- `sub <id> blocked` writes the child signal and the parent signal as `blocked`
  with `subtask <id>: <reason>`; the next child step or completion restores
  `running` on both.
- A child has no flow terminal contract: `--report <artifact>` is its only
  artifact rule, and the parent's contract still governs the parent's own
  terminal mark, which is refused while any child is unsettled.

## Acceptance-criteria ledger

[ADR-062](../adr/062-recorded-run-evidence.md) owns the sole normal verdict
writer: the recipe engine. A successful selected attempt transfers its schema-2
ledger into `artifacts/acceptance-status.json`; this task-namespace projection is
transport, never an independent reducer or a recorded package. A QA task records
one package per case, so its projection merges case executions by claim id and
each row names its case execution ([QA case ledger](recorded-run-evidence.md#qa-case-ledger)).

`farmslot-agent ac list` reads the registered criteria and verdicts; `ac render`
prints structured coverage. When a recipe exists, the terminal contract still
requires `artifacts/recipe-coverage.md`. Render it through the supplied `ac render`
command; it is a display artifact, never acceptance authority.
`ac set` is removed and refuses without writing.
Non-UI claims use eligible recipe assertions over actual command results or
file/log observations. A manual actor string grants no override authority.

Task-ledger writes and current successful completion reject schema 1. Retained
schema-1 ledgers remain display only, with their original bytes, verdicts and
explicit limitation caption. The shared review model uses the existing run
contract version to reserve Legacy for pre-cutover records; a newer run without
valid engine evidence is Invalid. A video or manifest alone proves no criterion
and supplies no measured timeline. Current readers do not derive AC links from
manifest `covers` or read `recipe-coverage.md` as a coverage fallback.

Successful completion requires every registered criterion to have an engine
verdict, including contracts without an opt-in. For PR follow-ups,
[ADR-062 inherited acceptance](recorded-run-evidence.md#inherited-acceptance-for-pr-completion)
permits a matching provisional parent reference instead of a new task ledger;
gateway completion independently qualifies the original proof. `acceptance.requireFresh`
retains the task-owned requirement. Otherwise, missing ledgers or unreadable
handoffs refuse. Weak or missing engine verdicts refuse unless
`acceptance.allowWeak` is set. No-change and self-review keep their existing
outcome contracts. `acceptance.require` cannot disable successful-completion
enforcement. Schema-2 verdicts are engine-owned. Local commands refuse every
change, including an actor-labelled untestable override. A gateway-generated
`claimReviewGate` contract lets ordinary completion reach human review after the
canonical SDK reader validates and binds the selected package (for a QA case
ledger, each row's case package). Unresolved verdicts
still block approval. A credential-backed person uses `farmslot run gate <runId>
--action mark-untestable --claim <id> --recipe-run <id> --reason <text>`; the gateway
stores the receipt without changing engine or task bytes. Flows without a human
review gate keep their refusal. See [verified claim overrides](recorded-run-evidence.md#verified-claim-overrides).

`artifact-check` validates task closeout files. When recipe artifacts exist, `recipe-quality.json` must satisfy the shared `RecipeQualityArtifact` validator from `@farmslot/protocol`.

`recipe-quality build` lets an agent provide the fields it knows after review — verdict, reasons, findings, suggested deltas, and proof metadata — and receive a complete `artifacts/recipe-quality.json` that passes the protocol validator. Use an input JSON file for nested findings/dimensions and repeated CLI flags for simple cases:

```bash
farmslot-agent recipe-quality build \
  --verdict warn \
  --reason 'Main claim is covered, teardown proof is missing.' \
  --delta 'Add a teardown assertion node.' \
  --proof-mode mixed \
  --output artifacts/recipe-quality.json
```

The builder preserves additive metadata under `extra` while protecting the required protocol fields from being overwritten. Use `--input -` to read compact JSON from stdin. CLI flags override file-provided scalar and array fields; `trainingFields` merge field-by-field so flags can refine proof metadata without dropping project or flow metadata.

## Compatibility

The previous script paths in `@farmslot/skills` and `scripts/quality/` remain compatibility shims for one migration window. New templates should point to `packages/agent-runtime/scripts/*` in the Farmslot monorepo or use `farmslot-agent` when installed as a package.

## Managed native reviewer approval policy

The gateway sets the private worker launch `approvalPolicy` to `never` only for the review role. Native Codex applies that policy to both `thread/start` and `thread/resume`. Reviewers keep the run's safety tier and the same sandbox, Git metadata write roots and optional filesystem policy they already had. Producing workers and standalone sessions keep their existing approval defaults.

This optional private field accepts only `never`. It is not a public session parameter. The gateway rederives it on reviewer resume; it does not enter the launch digest, so applying the approved policy does not invalidate retained reviewer sessions. The tier, environment and filesystem grants remain digest-bound. The gateway continues to deny any unexpected approval request, and never grants sandbox escalation.

## In-flight reviewer continuity

**Status:** Accepted under ADR-057 Amendment 6 (approved by the lead 2026-10-24).

A running HUMAN_GATE MUST retain publication-review recovery ownership after its
review-request decision has been consumed. Startup MUST ingest its completed
reviewer or re-arm the existing bounded watcher while that reviewer runs. The
watcher MUST retain attempt freshness, lineage, captured-head and artifact checks;
collecting a relaunch fallback MUST update its existing review rather than leave
older findings authoritative. Existing held/accepted approval priority stays intact.

Reattaching an accepted, still-live native reviewer MUST validate its persisted
slot, task, owner, profile, lease and process generation and monitor that generation.
It MUST NOT rebuild launch configuration or redeliver the task because pool,
project or source settings changed. The existing process retains its original
launch settings and filesystem grants. Unconfirmed launches, stopped processes,
explicit recovery, task transfers and parking restores retain their existing
launch-digest checks.

This gateway-only behavior uses existing native snapshot and command contracts.
It adds no public RPC, field, CLI flag, SDK export or harness configuration and
requires no runtime publication or native-host restart.

## Native session host

Claude saved-session recovery requires sessions started with Claude Code 2.1.265
or newer. Earlier releases have documented native history-loss bugs: [2.1.83
fixed hook progress forking the conversation chain, and 2.1.265 fixed resume after
tool-process interruption](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
Farmslot leaves those older sessions readable and closeable but disables recovery
with an explicit reason. Updating a binary cannot establish that an older saved
conversation is complete. Start a new session after updating the native runner;
Farmslot neither rewrites its history nor replays previous work to fill gaps.

`@farmslot/agent-runtime/native` exports `NativeSessionClient`. The gateway runner
layer validates registry capabilities and model policy, then calls this client.
Execution nodes can use the same runtime without importing gateway code.

The client starts a detached supervisor and host on demand. The host owns native
stdin; the supervisor stops wrapper groups and observed descendants after host failure.
The native launch wrapper waits for durable PID registration before executing the
installed binary. Closing a session waits for that cleanup to finish.
A gateway or browser disconnect only ends its RPC connection.

Set `FARMSLOT_NATIVE_STATE_DIR` to a stable private directory for each configured
execution profile. The default is `native-sessions` beneath `FARMSLOT_HOME`, or
the `.farmslot/native-sessions` directory under the current user's home when no home override is configured. State directories
require mode 0700 and files use 0600. A hashed socket path under `/tmp` fits macOS
limits. IPC uses a private random bearer token, distinct from provider credentials.
Native authentication environment and configuration stay inherited locally;
the runtime does not serialize them or send them over IPC. Account labels under
one OS user do not provide tenant isolation.

Session journals append events and changed metadata/receipts, fsyncing command
intent before submission. Receipts distinguish pending, unknown, accepted, failed
and completed. `submitted` records a submission attempt; only `accepted` records
native acknowledgement. A lost reply or unknown receipt never triggers a resend.
`native.session.cancel` (host method `cancelCommand`; `native.worker.cancelCommand` under
the worker's generation and lease) removes a command still queued for the next turn. The
host persists it as `failed`, never submitted, with outcome `cancelled`, before it replies;
a repeated call returns the same receipt. It refuses a command that was submitted, is
unknown, settled otherwise, or belongs to another generation or worker lease. Removal and
the queue's own submission are each decided synchronously on the host's event loop, so
exactly one wins. Sessions on a host that removes queued commands report
`capabilities.cancelQueued`, except in a pinned worker read the gateway serves for a run
whose worker messages are acceptance sources, where the gateway refuses removal. An older
host refuses the method as unknown
([ADR-057 Amendment 9](../adr/057-structured-runner-transports.md#amendment-9-queued-messages-steering-plans-and-per-turn-changes-2026-10-31)).
A send with `delivery: 'steer'` (host method `steer`; `native.worker.steer` under the
worker's lease) adds the message to the running turn when the adapter declares
`capabilities.steer`, the session is `running`, no request is pending and no submission is in
flight; otherwise it is an ordinary send. The intent is journaled before the runner write. The
runner's reply is acceptance, an error reply fails the command without a resend, and a lost reply
(the runner stopped, or the request timed out) stays unknown. The receipt carries `steered: true` and settles with the turn it
joined. Codex steers with `turn/steer` (`expectedTurnId`, the command ID as
`clientUserMessageId`); Claude and ACP do not declare `steer`. An older host refuses the method
as unknown.
`read` accepts `after` and `limit`, returns a cursor and `hasMore`, and exposes the
latest 100 receipts. Older IDs remain deduplicated across process generations;
a missing receipt in a page does not mean the command was never submitted. Consume each page once and
persist its returned cursor. Pending interactions are separate from the event
page. Respond with `request.id`; `nativeId` is evidence, not an input token.
The `approval.resolved` event that ends a pending interaction carries its `request`
and, when this host delivered the response, that `response` (`decision` or
`answers`). A resolution the host did not deliver has no `response`: its decision
is unknown ([ADR-057 Amendment 7](../adr/057-structured-runner-transports.md#amendment-7-record-how-an-approval-or-question-was-resolved-2026-10-31)).

Adapters normalize each tool call into `tool.kind`, `tool.command` and `tool.paths`
([ADR-057 Amendment 8](../adr/057-structured-runner-transports.md#amendment-8-normalized-tool-kinds-2026-10-31));
`tool.name` keeps the runner's own name. Claude maps `Bash` to `command`, `Read` to
`file-read`, `Edit`, `MultiEdit`, `Write` and `NotebookEdit` to `file-edit`, `Grep` and
`Glob` to `search` (their search root as the path), and `WebFetch` and `WebSearch` to
`web`; any other Claude tool is `other`. Codex maps `commandExecution` to `command`, with
the command line inside the shell Codex wraps it in (`/bin/zsh -lc 'git status'` is
`git status`; anything that is not one quoted word stays as sent), `fileChange` to `file-edit` with its changed paths, `webSearch` to `web`, and any other
item to `other`. ACP maps the tool call's `kind`: `execute` to `command` (with
`rawInput.command`), `read` to `file-read`, `edit`, `delete` and `move` to `file-edit`,
`search` to `search`, `fetch` to `web` and any other value to `other`, with its
`locations` as paths. An ACP update that omits them keeps the call's earlier values, and a
call that never sends a kind has none.

A `plan.updated` event carries the runner's whole plan, which replaces its earlier plan of
the same kind in that turn
([ADR-057 Amendment 9](../adr/057-structured-runner-transports.md#amendment-9-queued-messages-steering-plans-and-per-turn-changes-2026-10-31)):
a `checklist` of steps (`pending`, `in-progress` or `completed`, with an optional note) or a
`proposal` in markdown. Codex maps `turn/plan/updated` to a checklist (its `explanation` is
the note) and a completed `plan` item to a proposal, ignoring the item's streamed deltas; it
starts each thread with `tools.update_plan.enabled`, without which the app-server sends no
plan updates. ACP
maps a `plan` update to a checklist, dropping entry `priority`. Claude sends no plans yet.

For a session whose working directory is in a Git working tree and not read-only, the
host checkpoints the working tree before each turn (after journaling its first command,
before the runner write; delivery waits at most 5 s) and after it
([ADR-057 Amendment 9](../adr/057-structured-runner-transports.md#amendment-9-queued-messages-steering-plans-and-per-turn-changes-2026-10-31)).
A checkpoint is a commit built in a temporary index copied from the worktree's index, with
`HEAD` as parent and untracked files Git does not ignore (each up to 10 MiB), kept under
`refs/farmslot/native/<sessionId>/`; the worktree, its index, `HEAD` and branches are
untouched. After the turn the host appends `turn.changes` with both checkpoints and the
changed files (repository-relative paths, line counts, at most 500), or why they are
`unavailable`. `native.session.turn.diff` returns one listed file's diff between them. A
session keeps its last 100 checkpoints and deletes its refs at close; a diff past that is
refused as no longer retained.

After runner or host failure, reads expose failure and recovery instructions.
Explicit `create` with the recorded `resumeSessionId` retains the Farmslot session
ID and command history, and starts a new generation only after confirmed cleanup
of the previous generation. It preserves the working directory and native account configuration.
It never starts a blank conversation as a recovery fallback. Unknown acceptance
remains unknown, including after resume. Stale approval IDs cannot target the new
generation. An interrupt reply acknowledges native control; the ordered terminal
turn event supplies the actual interrupted/completed outcome.

The host uses source entry points with the workspace TypeScript loader during
development, and packaged `dist/native` entry points after `yarn workspace
@farmslot/agent-runtime build`. Ship the entire native output directory. Existing
hosts retain their loaded code until stopped. Finish/close sessions before an
operator stops the supervisor for an upgrade; restarting the gateway alone keeps
those sessions on the existing host.

A partial ownership claim or a surviving process whose death cannot be verified
blocks automatic takeover. Inspect `host.log`, the private lock/worker records,
and the recorded process groups before removing a stale claim. Never remove a
lock while its supervisor or host is alive. PID reuse is treated conservatively;
the runtime does not kill an unrelated live group to force recovery. The supervisor and each runner track OS descendant identity and retain detached
children for cleanup. They stop observed owners before the final process scan and
verify process start metadata before each signal. Processes that fully daemonize
and reparent between scans cannot be attributed reliably; full OS containment and
node-loss survival remain outside this phase. Journals currently remain on disk for the
session lifetime and load into host memory; archival/compaction is not implemented.

See the staged live proof in the runner validation operations guide. Local
regressions run with `node --import tsx --test
packages/agent-runtime/src/native/durability.test.ts`. The host test needs permission
to bind a local Unix socket. The same regression can run from the built output
with `node --test packages/agent-runtime/dist/native/durability.test.js`.
