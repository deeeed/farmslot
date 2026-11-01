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

**Status:** Accepted (approved by the lead 2026-10-31); part 1 (remove and edit) implemented in #1658; part 2 (plan updates: checklists and proposed plans) implemented in #1668; part 3 (steer) implemented in #1671; part 4 (per-turn changes) implemented in #1674; Implement, as a new session (the lead, 2026-11-01), implemented in this change.

### Decision

**Remove a queued message.** `native.session.cancel` takes a session target and a `commandId`.

- The host fails a command that is still queued and was never submitted: `state: 'failed'`, `submitted: false`, `accepted: false`, `outcome: 'cancelled'`, persisted before the reply. It returns that receipt, and a repeated call returns the same receipt.
- It refuses a command that was submitted, is unknown, failed for another reason, or belongs to another generation or worker lease. The client offers Stop instead.
- Removal and the queue's own submission are each decided synchronously on the host's event loop, so exactly one of them wins.
- A worker call carries the same pinned target and passes the same gateway fence as a worker message, then the host's lease check (`native.worker.cancelCommand`; `native.worker.cancel` still cancels a worker launch). The gateway refuses command IDs it issued itself (task, subtask, recovery, run instruction and completion feedback IDs), and messages on a run that records them through acceptance registration, until that ledger can withdraw an instruction.

**Edit a queued message** = remove, then send again with a new command ID. The removed text returns to the composer through the existing dropped-message path (`nativeMessageDropped`), and the edited text goes to the end of the queue. There is no in-place edit: a command ID stays bound to its text, which keeps retries idempotent.

Clients show Edit on the queued message they sent while `nativeMessageCancelable` holds: the session reports `capabilities.cancelQueued`, and the receipt is queued, unsubmitted and of the session's current generation. The host reports the capability; the gateway withholds it from a pinned worker's read on a run whose worker messages are acceptance sources, since it refuses removal there.

**Steer.** `native.session.send` accepts `delivery: 'steer'`. The host adds the message to the running turn only if all of these hold, and otherwise sends it as usual:

- the adapter declares `capabilities.steer`;
- the session is `running` (its turn is known);
- no request is pending and no submission is in flight.

The intent is journaled before the write to the runner, as for any submission. The runner's reply is acceptance; a refusal (an error reply, such as when the turn ended first) fails the command, and nothing is resent. A lost reply (the runner stopped, or the request timed out) stays unknown. The receipt carries `steered: true`, and the command completes or fails with the turn it joined, so it never holds up queued input. The turn's own events stay stamped with the command that started it.

Codex declares `steer` and calls `turn/steer` with the turn as `expectedTurnId` and the command ID as `clientUserMessageId` (`turn/steer` exists from Codex 0.156.1; the fleet runs 0.166.0, and an older Codex answers it with an error, which fails the command visibly). Claude and ACP declare nothing: Claude's "now" priority ends the turn, and ACP has no mid-turn input. Clients offer Steer next to "Queue message" while `nativeSteerAvailable` holds (the capability and a running turn); a session that cannot steer keeps "Queue message" and Stop. **Stop and send:** clients without steer offer "Stop and send": interrupt, then send; the send queues and runs once the interrupted turn ends. It needs no contract change and follows in its own change. A client releases the one message it holds once the runner accepted it and the conversation shows it (`nativeCommandLockSettled`), not only when its turn ends, so the reader can steer or queue while their own turn runs.

Steering reaches the host as its own method (`steer`, and `native.worker.steer` under the worker's lease), so a host started before this change refuses it as an unknown method instead of dropping the field and queueing the message. A pinned worker's steer passes the same gateway fence as its other messages. On a run that records worker messages for acceptance the gateway refuses it, since that ledger records an instruction for the next turn, and withholds `steer` from that worker's read.

**Plan updates.** A `plan.updated` event carries a `plan` of one of two kinds:

- `kind: 'checklist'`: the runner's working steps, `steps: [{ text, status: 'pending' | 'in-progress' | 'completed' }]`, with an optional note in `text`.
- `kind: 'proposal'`: a plan proposed before acting, as markdown in `text`.

Each event carries the whole plan and replaces the earlier plan of the same kind in that turn. Adapters map:

- Codex `turn/plan/updated` to a checklist (its `explanation` is the note). The app-server leaves Codex's plan tool off unless the thread enables it, so the adapter starts every thread with `tools.update_plan.enabled`: on 0.166 a three-step prompt sent no plan updates without it and four with it. The tool only reports progress;
- a completed Codex `plan` item to a proposal; its streamed deltas are ignored, since they need not match the final text;
- an ACP `plan` update to a checklist; entry `priority` is dropped.

Claude's TodoWrite and ExitPlanMode come later, after a live check of what Claude's headless mode sends.

A checklist is one timeline entry per turn and kind, at the place and key of its first update, holding the latest plan. It shows its steps while its turn runs and folds to its progress ("3 of 5 steps") once the turn ends, unless the reader watched it run. A proposal is a card: markdown, collapsed when long, with a copy action.

**Implement.** When the latest turn of an idle, standalone plan-mode session ended with a proposal, nothing is pending and the client's own last message has settled (a refinement may still change the plan), the card also offers Implement (`nativeImplementableKey`). It starts a new default-mode session on the planning session's node, runner, model, effort, account profile and working directory (`nativeImplementSession`), whose first message is "PLEASE IMPLEMENT THIS PLAN:" and the plan (`nativeImplementPrompt`), and opens it. That message is kept as the new conversation's pending message before it is sent, like a typed one, so its delivery shows there; a client runs one Implement at a time until the new conversation opens. A pinned worker's view cannot start sessions, so it offers none. Refine needs nothing new: the reader answers in the plan-mode session.

The approved text switched the session's mode instead (`send` with `mode`, `capabilities.turnModes`). A live check on Codex 0.166 (2026-11-01) showed that a thread stays in plan mode once it entered it: a turn sent with `collaborationMode: default` after a plan turn still answered "I'm still in Plan Mode" and changed no file, with developer instructions null or omitted (as t3-code sends them) and with t3-code's wording. The lead chose a new session (2026-11-01), so `mode` on `send` and `turnModes` are not added.

**Per-turn changes.** For a session whose working directory is in a Git working tree, the host takes a checkpoint before and after each turn:

1. when it submits the turn's first command, after journaling it and before writing to the runner;
2. when the turn ends.

- A checkpoint is a commit of the working tree's content, untracked files Git does not ignore included, with `HEAD` as parent. It is built in the session's own index, kept in the host's state directory, seeded from the worktree's index and reseeded only when that changes. It is kept under `refs/farmslot/native/<sessionId>/` and touches no file, index, `HEAD` or branch of the worktree. An untracked file over 10 MiB when first seen is left out, and one removed while a checkpoint lists it is skipped. A checkpoint whose tree equals the previous one reuses it, so an unchanged worktree adds no commit or ref. A session's checkpoint steps run one at a time.
- A turn's first command is journaled after the previous turn's `turn.changes`, so each turn's changes sit under its own message, and its start checkpoint is taken before the runner write. Delivery waits for both at most 3 s in all, then proceeds. A previous turn's checkpoint still running then is reported unavailable, so it cannot take in the next turn's edits, and a start checkpoint still running leaves that turn's changes unavailable. A failed checkpoint never fails a turn. The approved text said checkpoints never block delivery; a start taken after the runner's first write would give that write to the previous turn, so delivery waits, bounded, instead.
- After the end checkpoint the host appends `turn.changes` for the turn's command: `changes: { from, to, files: [{ path, status: 'added' | 'modified' | 'deleted', additions?, deletions? }], truncated?, unavailable? }`. Paths are relative to the repository root, a binary file has no counts, and at most 500 files are listed (`truncated` past that). `unavailable` says why a turn has no changes to show.
- `native.session.turn.diff` takes a session target, the `sequence` of a `turn.changes` event and a `path` it lists, and returns that file's diff between the two checkpoints, within the workspace diff's 1 MiB limit. It is served with the workspace reads, behind their worker fence.
- The host keeps a session's last 100 checkpoints and deletes its refs and index when the session closes, including a session that failed or was restored after a host restart. A failure to delete them is shown as an `error` event, and closing again retries. A diff whose checkpoints are no longer under the session's refs is refused as no longer retained.
- A session whose working directory is read-only (a sandboxed reviewer) takes no checkpoints. Edits made between turns fall outside both checkpoints; changes made during a turn by background processes, or by a pull or rebase, count as the turn's.

Command Center shows what each finished turn changed ("Changed 3 files · +12 −4"), and each file opens its diff in the shared diff viewer; a turn that changed nothing adds no row. Companion, and diffs after a session closes, come later.

### Rationale and consequences

A queued message could be dropped only by closing the session. The queue lives in the host, so removal needs no runner support.

Hosts keep their loaded code until stopped. A session on an older host reports no `cancelQueued`, so clients hide Edit and keep "Queue message" and Stop; that host refuses `native.session.cancel` as an unknown method. Older clients show a removed message as "Failed" and return its text to the composer.

Waiting for the turn to end delayed a correction until the work it corrected was done. Steering lets the reader adjust a running turn. Older clients never send `delivery`, and a client never offers Steer without the capability.

Codex and ACP runners already sent their plans; adapters dropped them, so a reader saw only the prose around them. A plan is shown, never acted on, so it needs no capability: an older host sends no `plan.updated`, and older clients skip the event. Cached histories saved before this change dropped plan events, so the history projection number is bumped and they are read again once.

The workspace pane answers "what differs from `HEAD` now", not "what did this message change", and shows nothing once the worker commits. A checkpoint taken by the host gives every Git-backed runner the same answer; Codex's own turn diff covers only Codex and is not used. The cost is Git work at each turn boundary and hidden refs in the repository's Git directory, which linked worktrees share; deleting a session's refs at close stops them piling up. No Farmslot flow mirror-pushes or prunes refs, and hidden refs already exist under `refs/farmslot/`.

Measured with this change's code on a shared clone of mini's MetaMask Mobile checkout (15,240 tracked files, uncommitted edits left in place, load about 3): the first checkpoint, which seeds the session's index, took 0.24 to 0.25 s, one with nothing changed since the last 0.14 to 0.15 s, one after a turn's edits 0.23 s, and the file summary 0.03 s. A read-only run of the same Git steps on macpro's six MetaMask Mobile worker checkouts (17,120 to 18,503 files, load about 13) took 0.34 to 0.79 s, and 0.23 to 0.39 s with nothing changed. The start checkpoint delays delivery by that much; the end checkpoint runs after the turn. Work avoided (COMMON "Extreme performance, clean architecture"):

- No rescan: the session's index persists between checkpoints, so Git's stat cache hashes only files changed since the previous one, untracked files included. It is reseeded only when the worktree's index changes, and the copy keeps that index's timestamp, so entries written in the same second are still re-checked.
- No recopy: a checkpoint is a Git tree; unchanged blobs are shared by hash with every earlier checkpoint and with the repository.
- No per-file spawns: one Git invocation per step. The file list and its counts come from one tree-to-tree diff, and a file's diff is computed only when a reader opens it.

An older host sends no `turn.changes`, so clients offer no turn diffs for its sessions, and an older node service refuses `native.session.turn.diff` as an unknown method. Older clients skip the event.

### Public surface

`native.session.cancel` (`NativeSessionCancelParams`, `NativeSessionCancelResult`), the receipt outcome `cancelled`, `NativeSessionCapabilities.cancelQueued` and the client-cache predicate `nativeMessageCancelable` in `@farmslot/protocol`. `@farmslot/agent-runtime` adds the host methods `cancelCommand` and `native.worker.cancelCommand`, so it needs a release; native hosts started after it support removal. The gateway adds the method to its worker input fence, authorization map and native method lists, and withholds the capability where it refuses removal; Companion adds it to its workspace method list. No CLI flag or harness change. The [agent-runtime specification](../reference/agent-runtime.md#native-session-host) defines the boundary.

Steer: `NativeSessionSendParams.delivery`, `NativeSessionCapabilities.steer`, the receipt flag `steered` and the client-cache predicate `nativeSteerAvailable` in `@farmslot/protocol`. `@farmslot/agent-runtime` adds the host methods `steer` and `native.worker.steer` and the Codex `turn/steer` call, so it needs a release; sessions started on a host after it can steer. The gateway routes a worker steer through its input fence and withholds the capability where it refuses it. No new gateway method.

Plan updates: the event type `plan.updated` with `NativeSessionPlan` and `NativePlanStep`, the `plan` timeline entry, `nativePlanText` and `nativePlanOpen` in the client cache, and the history projection bump, in `@farmslot/protocol`. `@farmslot/agent-runtime` maps the Codex and ACP plans and needs a release; native hosts started after it send plans. The gateway passes events through unchanged.

Implement: `nativeImplementableKey`, `nativeImplementPrompt` and `nativeImplementSession` in the client cache. Clients create and send through the existing `native.session.create` and `native.session.send`; no host, gateway or contract change.

Per-turn changes: the event type `turn.changes` with `NativeTurnChanges` and `NativeTurnFile`, the method `native.session.turn.diff` (`NativeSessionTurnDiffParams`, `NativeSessionTurnDiffResult`), the `changes` timeline entry and `nativeTurnChangesText` in the client cache, and another history projection bump, in `@farmslot/protocol`. `@farmslot/agent-runtime` takes the checkpoints and serves the diff, so it needs a release; native hosts and node services started after it support them. The gateway adds the method to its routes, worker read fence and authorization map. No CLI flag or harness change.

## Amendment 10: farm workers launch through the native adapters, 2026-11-01

**Status:** Proposed.

### Decision

A native farm worker is a native session started through the same runner adapter as a standalone session. The task binding sits on top: lease, launch environment, account setup, safety tier and approval policy.

- **No executable choice in the gateway.** The worker launch carries an executable only when the slot's pool configures one for that runner (`<runner>_path`). Otherwise the host starts the adapter's own executable, as it does for a standalone session.
- **Every native runner works as a worker.** Claude, Codex, Cursor and Grok run as native workers. This replaces "Cursor/Grok standalone adapters" in the implementation status above.
- **Fail fast.** A native run or queue item whose runner has no native adapter is refused at creation, before a slot is found or prepared.
- **Unchanged:**
  - Codex workers without a profile keep the farm-provisioned `codex-home`. That is account setup, not launch.
  - tmux stays first-class for every runner.

### Rationale

Standalone sessions and workers had two launch paths:

- the host's adapter registry, for chat;
- a per-runner executable switch in the gateway, for workers.

The gateway switch knew only Claude and Codex, so Grok chat worked while a Grok worker failed after its slot was prepared. One path removes the switch, and with it the class of runner that works in chat but not as a worker.
