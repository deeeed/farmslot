# ADR-057: Structured runner transports

**Status:** Accepted; approved rollout shipped through PR #635 on 2026-09-14
**Date:** 2026-09-12
**Scope:** [Runner execution PRD](../PRD-runner-execution-canonical.md), [near-term roadmap](../ROADMAP-next.md)
**Related:** [ADR-023](023-runner-agnostic-tui-execution.md), [ADR-032](032-runner-observability-via-hooks.md), [ADR-047](047-worker-session-history-panel.md), [ADR-051](051-principal-and-credential-model.md)
**Lifecycle:** Keep as the accepted decision for the native transport option. This adds an explicit alternative to ADR-023's default without rewriting historical tmux decisions.

## Context

Farmslot controls interactive runners through tmux. Terminal rendering differs by runner and does not reliably identify messages, tool results, permissions, or completed turns. Native history files improve read-only review but do not provide a complete input and event protocol.

Farmslot needs shared session controls in Command Center, Companion, CLI, and worker orchestration, including when a client cannot attach to tmux. Users must retain their own native runner accounts in both private farms and shared deployments.

## Decision

### Keep native runtimes and make transport explicit

The runtime owns the agent loop, tools, compaction, and authentication. The transport carries commands and events between that runtime and Farmslot. A Farmslot session identifies its execution node, runner, account context, native session, and selected transport independently of any terminal pane.

Keep tmux as the default. Add opt-in structured transports within the shared runner capability layer, starting with Codex app-server and the unmodified Claude structured process. Add Grok and Cursor through ACP. OpenCode is outside this delivery scope. Record the resolved executable, runner version, account mode, and negotiated capabilities for each launch. Unknown capabilities remain unavailable.

Existing tmux sessions continue through their current adapter. New native sessions do not require tmux. Saved-session resume and attachment to an existing process are separate capabilities. Arbitrary live TUI takeover is outside this decision.

### One command and event contract

Runner adapters own framing, native request IDs, launch syntax, permission handling, and event conversion. Workflow and client code consume shared capabilities without runner-name branches or terminal-text parsing.

The contract distinguishes command acceptance, turn start, text deltas, tool activity and results, permission requests, user questions, interruption, turn completion, and process failure. Preserve native IDs where available and correlate commands and pending requests with their session. Output silence, terminal redraws, and a successful write to stdin cannot establish turn completion or delivery acceptance.

Unsupported interactions fail closed. Missing evidence is unknown, never successful delivery or idle state. Native permission decisions keep their scope; transport access grants no additional dispatch, publication, merge, or execution authority.

### Durable ownership and recovery

Each session has one authoritative input owner on its execution node. Clients submit commands through the gateway to that owner. A tmux driver and a native adapter cannot independently write to the same session.

Use a supervised process on the execution node whose lifetime does not depend on a browser or gateway connection. Reuse node execution mechanisms where they meet that requirement. Persist session identity, command correlation, pending requests, and ordered events before acknowledging durable mutations. Replay uses cursors; duplicate commands retain their original outcome instead of delivering the prompt twice.

Worker dispatch must reserve and persist a lowercase session UUID before launch, then call `native.session.ensure`. Retrying that operation requires the same owner and launch configuration and returns the existing session, including closed or failed state. It never relaunches a terminal reservation. Ordinary `native.session.create` still creates a new session or explicitly resumes a saved conversation. The gateway requires the node to declare `supportsEnsure` before routing reserved creation; a newer client also refuses ensure against a retained host without that capability while preserving its ordinary session controls.

On reconnect, restore events and pending approvals for the same account and session. On process death, report the terminal state and offer saved-session resume only when the adapter verifies it. A crash between delivery and acknowledgment may leave acceptance unknown. Recovery must reconcile structured evidence or require explicit resolution rather than resend automatically. Node loss does not guarantee process survival.

History and archive readers reuse the native session identity and ownership boundary. Reconcile archive schema changes before integration so live events and archived messages do not create competing session records.

### Native authentication and execution ownership

Users install and sign into the native runner in their execution context. Farmslot does not collect subscription tokens in shared application state, route them into PI, impersonate an official client, or silently switch to paid API credentials. The runtime keeps its native authentication and tool behavior.

Account context comes from authorized execution context, not an arbitrary client-supplied label. Bind launch, history access, commands, and approval replies to that context. Profiles identify native configuration directories, not subscription identities. Login rotation in the same directory preserves saved conversations without re-enrollment. Resume remains within the same runner and reconciles accepted commands before further delivery; stale process-generation replies stay refused. Switching runners uses an explicit handover, outside saved-session resume. Keep credentials out of event history and client payloads.

Native node execution requires an issued node credential bound to the exact machine and `FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID` set on that node. `deploy-node.sh` carries this opt-in into its service environment. The node keeps native journals under its own Farmslot home and retains runner installation and login locally. Session and workspace requests include `executionNodeId`; omission continues to select the gateway host. Replacing a node connection cannot answer requests sent to the previous connection, and a missing node never redirects a session to the gateway host.

The first implementation was restricted to a pinned principal in a single trusted operator context. The account-setup phase adds optional profiles belonging to one trusted operator under one OS user. Each product user owns their execution node. Prove profile-directory binding, owner routing, and conversation continuity across ordinary login rotation. Profile directories do not isolate mutually untrusted users sharing an OS account.

Successful inference establishes access at the time of the request. Subscription entitlement, permitted automation, quotas, and billing require separate provider-specific evidence. Compare equivalent native TUI and structured tasks using provider usage records where available. Mark unavailable or delayed billing evidence explicitly. Initialization and estimated token cost cannot establish subscription economics.

### Workspace boundaries

Codex `sandboxed` and `full-auto` sessions may write the workspace and its Git common directory. For linked worktrees this includes the primary checkout's shared Git metadata, including HEAD, index, refs, and other worktree metadata. The tier does not isolate repository metadata between the trusted operator's worktrees.

Pool machine environment values are part of the native worker's `launchDigest`. Changing one, including rotating a configured load-balancer key, invalidates recovery, retained handoff, and parking restore for the old launch. Finish those tasks before changing the environment, or restart them explicitly with the new configuration.

### Parking portability

Native worker parking must support restoring the saved conversation into another eligible slot in this delivery. The runner layer owns any supported workspace relocation and records the destination identity. Prove source process cleanup, destination reservation, owner continuity, and retry/cancellation behavior before exposing restore. Do not satisfy portability by starting an unrelated conversation.

Parking preserves the full task bundle, including artifacts, with a 64 MiB file-content limit and no symlinks or special files. Oversized or unsupported bundles refuse parking; artifacts are not silently omitted. The separate artifact mirror does not replace files a resumed worker may still need.

### Client integration and code reuse

Command Center first consumes structured sessions through the existing Copilot UI. Workers, retained reviewers, remote nodes, and Companion then consume the same commands and events. Keep terminal viewing for tmux sessions and visibly disable interactions an adapter cannot provide.

T3's MIT-licensed adapter code may be copied where useful, with required notices and dependency license checks. Do not import its whole application architecture. PI remains a possible later runtime; PI-TUI is terminal rendering and does not replace this client protocol.

## Validation and rollout

G003's broader recovery proof found documented Claude Code 2.1.78 history-loss
defects that the earlier user-prompt recall test did not detect. Native Claude
recovery is therefore gated to sessions started with 2.1.265 or newer. Older
sessions remain readable/closeable and expose the unsupported capability. Test
tool-result and assistant-message context, not only tokens from user prompts.

G001 shipped in PR #615 with local Codex and Claude adapters. G002 shipped in PR #616 with process supervision, durable events, replay, and recovery. G003 Command Center integration shipped in PR #618. Remote node foundations shipped in PRs #619 and #620. PR #635 completed native workers, retained reviewers, cross-slot parking, Companion, Cursor/Grok standalone adapters, trusted-operator profiles, and the final integration review. Native, terminal, and PI intelligence load-balancer paths were validated; additional Codex profile-switch validation was deferred. Execution remains bound to the local profile owner or an assigned node owner; these capabilities do not establish isolation between untrusted users sharing an OS account or prove subscription billing.

| Phase | Deliverable                                         | Required proof                                                                                                                                                              |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Canonical contract and rollout                      | Explicit tmux defaults, ownership, account boundary, and capability gates                                                                                                   |
| 1     | Codex and Claude through gateway RPC                | Acceptance, streaming, benign tool result, approve and deny, questions where supported, interrupt, second-turn context, saved-session resume, and matching tmux regressions |
| 2     | Node supervision and durable events                 | Client and gateway reconnect, two concurrent sessions, replay without duplication, process failure, uncertain acceptance, stale and cross-account request rejection         |
| 3     | Native Copilot in Command Center                    | Complete a task through real controls without tmux; CDP and gateway assertions prove approval, interruption, refresh, and pending-request recovery                          |
| 4     | Workers, retained reviewers, remote node, Companion | Real dispatch and handoff, second-machine execution, reconnect, mobile approval and continuation of the exact session, and tmux compatibility                               |
| 5     | Grok, Cursor, account setup                         | Each declared capability passes the common suite; native login rotation preserves conversations; profile and node ownership stay enforced                                   |

Use production gateway scenarios in `scripts/runner-validation/`. Unit tests guard regressions but do not establish runner behavior. Every new live assertion needs a negative check that demonstrates it can fail. Browser validation drives real controls without injecting UI state. Keep bounded provider usage observations separate from protocol evidence and private account details outside public docs.

Keep an adapter experimental if interactive permissions or exact session continuity fail. Do not release client controls for an unproven capability. All phases are approved work, and initialization-only probes do not complete phase 1.

## Consequences

Farmslot can present agent sessions without terminal rendering while retaining native runner behavior. Protocol version changes become adapter maintenance, with capability checks and live scenarios guarding compatibility.

This decision adds durable process and event ownership to the execution node. Each product user owns their execution node; optional profile directories are not isolation for mutually untrusted users sharing an OS account. It does not establish cheaper inference, unlimited unattended use, or subscription permission for a custom PI runtime.

## Trusted operator profile scope

Several profiles on one OS user belong to one trusted operator; each product user owns their own execution node. Reuse native configuration directories and preserve conversation history across ordinary login rotation. Keep process ownership and approval routing bound to the node owner and session generation. Profiles are optional for side-by-side configurations; saved-session resume never changes runners. This delivery does not isolate mutually untrusted users on the same node. No separate sandbox, container or host-tool broker is required. Keep future extensions in the runner capability layer.

## Load-balancer configuration

Native Codex keeps its configured provider and transport. With codex-lb, the native endpoint is `http://127.0.0.1:2455/backend-api/codex`; the client key comes from `CODEX_LB_API_KEY`. Native API-key authentication can use that client key without a direct ChatGPT OAuth login. Use a separate native configuration when establishing a different credential profile, and preserve existing conversation files.

Gateway intelligence can explicitly select the `codex-lb` provider in LLM settings. PI uses the load balancer's SDK endpoint, `http://127.0.0.1:2455/v1`, with Astra/low defaults and the same environment key. It does not import upstream OAuth credentials or fall back to another provider when the key or request fails. Other saved provider choices remain authoritative. This HTTP/SSE route serves fresh intelligence requests; native agent sessions retain their configured WebSocket transport. API list prices are not reported as subscription charges.

## Amendment 1: reconcile stopped native hosts, 2026-10-15

**Status:** Proposed; lead-authorized scope, acceptance follows paired review.

### Decision

The existing native-host startup may reconcile a retained failed cleanup marker
under its exclusive startup claim. It requires a fresh OS census, absent recorded
supervisor/host processes and groups, and terminal session journals with confirmed
process stops and stopped original runner groups. Journal observations are scoped
to the failed host's latest generations; OS birth identities distinguish unrelated
PID/group reuse. Orphaned or unreadable groups remain blocked.
Missing host ownership, malformed or unreadable evidence, and any surviving process
keep ownership blocked. Recovery never signals a process.

A host whose first census failed before recording any session may have no process
observations. Under the same startup claim, fresh and independent absence checks
may quarantine that marker and start a new host. Historical journals must remain
terminal and confirmed stopped; any session recorded by the unobserved host blocks
this fallback. No journal is reset, and starting a host never resumes a worker.

Archive the original cleanup record and a durable verification receipt before
reclaiming the stale host lock. Preserve journals, native IDs, generations, command
outcomes, pending requests, account configuration and run links. Starting the host
does not resume a runner or resend a command. Normative rules live in
[Agent runtime](../reference/agent-runtime.md#native-host-cleanup-recovery).

### Rationale and consequences

A process-census timeout can leave cleanup unknown after all owned processes stop.
Fresh verification permits safe same-root recovery without deleting state or
manually clearing the marker. Recovery adds a private historical receipt; uncertain
cleanup continues to refuse startup.

### Public surface

Existing `native.session.list` and session/worker RPCs keep their ownership checks
and `executionNodeId` selection. Their normal host startup invokes the recovery.
No CLI flag or RPC is added. `@farmslot/agent-runtime` owns supervision, consumed by
the gateway and execution-node `NativeSessionClient`; harnesses inherit it through
those consumers. This ships as a runtime patch and requires the consuming node's
runtime update.

## Amendment 2: recover a host stopped with a live session, 2026-10-18

**Status:** Accepted 2026-10-18 by the lead after paired review of 064fa7f7.

### Decision

Amendment 1 recovery also accepts a session journal whose recorded runner belongs
to the failed host when that journal is still active or its process stop is
unconfirmed. Its runner, runner group and recorded descendants must pass the same
fresh census and independent absence checks. Journals of every other host must
still be terminal and confirmed stopped. Recovery leaves the journal unchanged; the
new host marks the session failed when it loads it, as for any session its
predecessor left open.

### Rationale and consequences

On macwork on 2026-10-18 a census timeout stopped the host while a native reviewer
session was open. Cleanup killed the runner group but failed on `ps` before it could
record the stop, so that journal stayed idle and unconfirmed. Amendment 1 then
refused every later host start, even once `ps` was fast. Cleanup that a census
timeout leaves unconfirmed is now confirmed by the next start; a survivor or a
failed census still refuses, and the next start tries again.

## Amendment 3: a slow process census does not stop the native host, 2026-10-20

**Status:** Proposed. The lead approved the direction on 2026-10-20; acceptance follows paired review.
**Trigger:** five native host deaths on macwork between 10-15 and 10-19, each recorded in `cleanup-recoveries/`: 10-15 14:06Z, 10-18 08:55Z, 10-18 ~11Z, 10-19 ~11:2xZ and 10-19 13:24Z. Each began with "Native process census exceeded its deadline" while the machine was overloaded; on 10-19 it was at load 305 with about 2000 processes. Each death killed every native session in flight, including TAT-4006 7721a02b's reviewer.

### Decision

The shared process census that observes a native host's process tree waits up to 30 seconds for `ps` before it fails its observers. The deadline was 5 seconds. A census that misses the 30-second deadline, or a `ps` that fails, still fails every observer, so the supervisor still stops the host fail-closed.

The synchronous reads used by host cleanup and startup recovery keep their 5-second timeout. A cleanup that times out still leaves cleanup `unknown`, and the next start recovers under Amendments 1 and 2.

### Rationale and consequences

On a loaded machine, a single slow `ps` is not evidence that ownership was lost. It killed the host and every session it ran, even though the next census would have succeeded. The cost is detection time: a truly hung census is noticed after up to 30 seconds instead of 5. A descendant that is spawned and orphaned between two censuses was never observable, whatever the deadline; a longer census widens that window. While `ps` is between 5 and 30 seconds, the synchronous 5-second reads still fail closed: a session launch fails, and a runner close is left unconfirmed until reconciliation finds its group gone or the host restarts. The host and its other sessions keep running.

### Public surface

No API, flag or field. The change is in `@farmslot/agent-runtime` `native/process-tree.ts`, where the observer census and the synchronous reads now use separate deadlines. It ships as a runtime patch, and every node needs the runtime update and a native host restart.

## Amendment 4: one completion turn for an unfinished native reviewer, 2026-10-23

**Status:** Accepted 2026-10-23 under the lead's standing approval after paired policy review.

### Decision

When an admitted native reviewer ends its turn after writing a valid review result
but leaves its own signal nonterminal, the gateway requests one completion turn in
the same saved conversation before failing the review. This includes a failed turn
whose result artifacts are valid, such as a provider capacity failure after the
report was written. A still-running turn stays under the existing progress watchdog.

The existing native owner reserves that completion instruction durably before
delivery. Reconnection and uncertain replies reconcile the same command receipt;
they do not grant another turn. A live idle conversation receives the command
through its current lease. A stopped process resumes only after confirmed cleanup
and verification of the same saved conversation and launch settings. Unsupported or
unverifiable resume fails with the recorded reason, without starting a fresh review.

Preserve the review admission, reviewed input, task, checklist attempt, owner,
execution node, runner, model and account profile. The completion command has its
own receipt. Completion and schema-bound visual-result readers consume that
command and its verified process generation. The first command's failure remains
in history. The follow-up must finish the existing task-local terminal contract;
artifacts alone never establish completion. A second unfinished turn fails clearly.
Cancellation, interruption, supersession, lost ownership and invalid artifacts do
not authorize a continuation. Existing progress and review budgets still apply.

### Rationale and consequences

A reviewer can finish its findings and report, then lose its turn before running
the final mark. Immediate failure discards usable work and forces another review.
One durable completion command preserves that work while bounding automatic
recovery. Its retries retain the same identity across gateway restarts.

This finishes the original review attempt. It does not change WARM/COLD selection,
review ranges or round accounting under ADR-063. Normative rules live in
[Agent runtime](../reference/agent-runtime.md#native-reviewer-completion-turn).

### Public surface

The gateway's native review controller consumes the existing private worker
send/resume capability and command journal. Existing reviewer instruction fields
record the reservation; no public field, RPC, CLI flag, SDK export or harness
configuration is added. Harnesses retain the same task-local mark contract. This
gateway-only fix requires no runtime publication or native-host restart.

## Amendment 5: managed reviewer commands without approval prompts, 2026-10-23

**Status:** Accepted policy, approved by Arthur and the lead on 2026-10-23. Implementation requires paired review.

### Decision

Worker-managed native reviewers use a no-prompt approval policy. Native Codex starts or resumes their threads with `approvalPolicy: never`. The reviewer's existing sandbox, writable roots and run safety tier stay unchanged. Worker and standalone session policy also stays unchanged.

The gateway owns this reviewer policy separately from the run tier. It rederives the policy when resuming a retained reviewer, preserving the conversation, lease and filesystem grants. Approval requests that a runner still emits remain denied.

### Rationale and consequences

Sandboxed reviewers inherited `untrusted`, while the gateway denied every approval request. Commands requiring approval could never run, so a review could stall without inspecting the code. Reviewers must be able to execute commands inside their existing sandbox without requesting escalation.

This changes command approval inside that sandbox, not filesystem access. The private runtime launch contract carries the reviewer policy; it adds no public session permission control. The owning spec is [Agent runtime](../reference/agent-runtime.md#managed-native-reviewer-approval-policy).

## Amendment 6: retain in-flight reviewer ownership across gateway updates, 2026-10-24

**Status:** Accepted (approved by the lead 2026-10-24).

### Decision

A running HUMAN_GATE retains publication-review recovery ownership after its review-request decision is consumed. Startup collects an already completed reviewer or re-arms the existing bounded recovery watcher until that reviewer finishes. A relaunch fallback's completed signal and result are ingested into its existing lineage; stale findings do not remain authoritative because the original await was lost.

An already accepted, still-live native reviewer generation is reattached by validating and monitoring its persisted binding. Reattachment does not rebuild a launch from current pool, project or source configuration and does not send its task again. Its original launch settings and filesystem grants remain in force. Slot, task, owner, profile, lease and generation fences still apply.

This applies to observing the existing process. Unconfirmed launches, stopped processes, explicit recovery, task transfers and parking restores retain their existing launch-digest checks. Held or accepted publication approvals retain their existing recovery priority; no new review or fix is authorized by restart.

### Rationale and consequences

A gateway update interrupted the await of an authorized review. The consumed decision stopped identifying recovery ownership, so the gate retained older findings even after its fallback reviewer finished. Rebuilding an accepted reviewer's launch also treated a configuration change as a reason to refuse monitoring, although its original process was still owned and running.

### Public surface

No public RPC, field, CLI flag, SDK export or harness extension changes. The gateway uses the existing native snapshot and command contracts. Runtime and decoder bytes do not change; no runtime publication or native-host restart is needed. The [agent-runtime specification](../reference/agent-runtime.md#in-flight-reviewer-continuity) defines the boundary.

## Amendment 7: record how an approval or question was resolved, 2026-10-31

**Status:** Accepted (approved by the lead 2026-10-31).

### Decision

`approval.resolved` carries an optional normalized `response`: `decision` for an approval, `answers` for a question. The native manager sets it from the response the host delivered for that request, beside the `request` it already attaches; the adapter event type has no such field. A resolution the host did not deliver, such as the runner resolving a request itself, leaves it out: the request was resolved and its decision is unknown. Runner-specific `data` stays diagnostic.

Clients keep each resolved request in the conversation as "Approved: …", "Declined: …", "Answered: question → answer", or "Resolved: …" when the decision is unknown.

### Rationale and consequences

A request left the conversation once resolved, so neither Command Center nor Companion could show what was approved or answered. The decision and answers existed only in runner-specific `data`, and Codex's own resolution notice carries none; reading them would need runner-name branches. The manager knows the response because it delivers it.

Hosts keep their loaded code until stopped, so a session started on an older host records resolutions without `response`; clients show those as "Resolved: …".

### Public surface

One optional field, `NativeSessionEvent.response`, in `@farmslot/protocol`. No RPC, CLI flag or harness change. `@farmslot/agent-runtime` sets it, so it needs a release; native hosts started after the upgrade record it. The [agent-runtime specification](../reference/agent-runtime.md#native-session-host) defines the boundary.

## Amendment 8: normalized tool kinds, 2026-10-31

**Status:** Accepted (approved by the lead 2026-10-31).

### Decision

`NativeSessionEvent.tool` gains three optional fields, set by each runner adapter: `kind` (`command`, `file-edit`, `file-read`, `search`, `web` or `other`), `command` (the command line a `command` tool runs) and `paths` (the files or directories a tool reads, changes or searches). `name` stays the runner's own tool name. An adapter that cannot tell leaves `kind` out, and clients treat it like `other`.

Clients read tool calls through these fields: "Run npm test", "Change a.ts, b.ts", "Read a.ts" or "Search src" in the tool row and the working status. A command's card shows what it ran and the last lines it printed, with its raw input and output one tap away. A tool without a kind or subject keeps the runner's name, and every tool but a command keeps its raw input and output as its card.

### Rationale and consequences

`tool.name` is runner-native (Claude `Bash`, Codex `commandExecution`), so clients could only show runner vocabulary or branch on runner names, which this ADR rules out. Each adapter already knows its runner's tools, so the mapping lives there.

Hosts keep their loaded code until stopped, so a session started on an older host shows runner names, as before.

### Public surface

`NativeSessionTool` and `NativeToolKind` in `@farmslot/protocol`, with the shared presenters `nativeToolLabel` and `nativeCommandText` in its client cache. No RPC, CLI flag or harness change. `@farmslot/agent-runtime` sets the fields, so it needs a release. The [agent-runtime specification](../reference/agent-runtime.md#native-session-host) lists each adapter's mapping.

## Amendment 9: queued messages, steering, plans and per-turn changes, 2026-10-31

**Status:** Accepted (approved by the lead 2026-10-31); part 1 (remove and edit) implemented in this change; steering, plans and per-turn changes follow in their own changes.

### Decision

**Remove a queued message.** `native.session.cancel` takes a session target and a `commandId`.

- The host fails a command that is still queued and was never submitted: `state: 'failed'`, `submitted: false`, `accepted: false`, `outcome: 'cancelled'`, persisted before the reply. It returns that receipt, and a repeated call returns the same receipt.
- It refuses a command that was submitted, is unknown, failed for another reason, or belongs to another generation or worker lease. The client offers Stop instead.
- Removal and the queue's own submission are each decided synchronously on the host's event loop, so exactly one of them wins.
- A worker call carries the same pinned target and passes the same gateway fence as a worker message, then the host's lease check (`native.worker.cancelCommand`; `native.worker.cancel` still cancels a worker launch). The gateway refuses command IDs it issued itself (task, subtask, recovery, run instruction and completion feedback IDs), and messages on a run that records them through acceptance registration, until that ledger can withdraw an instruction.

**Edit a queued message** = remove, then send again with a new command ID. The removed text returns to the composer through the existing dropped-message path (`nativeMessageDropped`), and the edited text goes to the end of the queue. There is no in-place edit: a command ID stays bound to its text, which keeps retries idempotent.

Clients show Edit on the queued message they sent while `nativeMessageCancelable` holds: the session's host reports `capabilities.cancelQueued`, and the receipt is queued, unsubmitted and of the session's current generation.

### Rationale and consequences

A queued message could be dropped only by closing the session. The queue lives in the host, so removal needs no runner support.

Hosts keep their loaded code until stopped. A session on an older host reports no `cancelQueued`, so clients hide Edit and keep "Queue message" and Stop; that host refuses `native.session.cancel` as an unknown method. Older clients show a removed message as "Failed" and return its text to the composer.

### Public surface

`native.session.cancel` (`NativeSessionCancelParams`, `NativeSessionCancelResult`), the receipt outcome `cancelled`, `NativeSessionCapabilities.cancelQueued` and the client-cache predicate `nativeMessageCancelable` in `@farmslot/protocol`. `@farmslot/agent-runtime` adds the host methods `cancelCommand` and `native.worker.cancelCommand`, so it needs a release; native hosts started after it support removal. The gateway adds the method to its worker input fence, authorization map and native method lists, and Companion to its workspace method list. No CLI flag or harness change. The [agent-runtime specification](../reference/agent-runtime.md#native-session-host) defines the boundary.
