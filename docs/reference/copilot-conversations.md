# Copilot and live conversations

Status: Accepted for implementation under [ADR-016 Amendment 1](../adr/016-d9-copilot.md#amendment-1-copilot-entry-and-live-conversations-2026-11-05).
Arthur approved implementation on 2026-11-06. The completion checks below remain release gates.
This is ADR-016's owning normative reference, maintained with that ADR. A separate
file is needed because no existing reference owns the copilot conversation contract.
[Agent runtime](agent-runtime.md) continues to own execution and delivery mechanics.

## Entry and interaction

Command Center MUST open on the copilot prompt for an authorized farm administrator
when no explicit route is supplied. Explicit run, family, fleet and session links
MUST still resolve. Restricted native-only readers MUST retain their permitted
workspace and MUST NOT gain farm access through the new default.

The shared launcher MUST offer the farm copilot and a native session in a selected
slot or custom directory. Reuse its project/machine filters, runner, model and effort
controls, including unavailable targets and their reasons. Directory resolution
MUST use the selected node's reported home and catalog. A normal prompt sends to
the selected conversation. A proposed run or launch shows its typed target and
confirmation before executing the existing command. An explicit launch submit is
that confirmation, subject to existing dangerous-launch confirmation requirements.

The configured copilot MUST be a singleton native session under its existing
execution owner and launch policy. Each open browser MUST NOT create its own agent.
Start and first send MUST use idempotent native ensure/send identities; explicit
stop MUST use the native close operation. Merely opening, restoring or subscribing
MUST NOT start, resume or send to a runner. Keep the existing copilot safety-tier,
workload and dangerous-launch checks. Do not auto-enable autostart on migration.
Existing explicit autostart configuration remains launch policy, independent of views.

Copilot, standalone and managed worker/reviewer conversations MUST use one shared
incremental controller and the existing native timeline model. Web and Companion
MAY have thin platform renderers. Tool results and operator packets remain collapsed
until opened. The composer MUST reflect native busy, queued, approval and question
state. Plain text MUST NOT resolve a gate or masquerade as a native acknowledgement.

## Current sources and reference parity

The following is a static source audit, not runtime proof. Farmslot baseline is
`5e07e927399ebc9b827c6d2ff3768bd206b4bd41`.

| Current path         | Source at that baseline                                                                                                                       | Required change                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Copilot send/history | `services/gateway/src/methods/chat.ts:66`                                                                                                     | Route clients to the bound native session journal and native commands.                              |
| Copilot output       | `services/gateway/src/copilot-runtime/controller.ts:75`, `:681`, `:693`                                                                       | Remove the 750 ms transcript timer, raw transcript decoding and chat-body writer.                   |
| Copilot view         | `apps/command-center/ui/src/components/chat/chat-panel.ts:120`, `:1182`                                                                       | Replace `CHAT_RESPONSE` text consumption with the shared conversation controller.                   |
| Native view          | `apps/command-center/ui/src/components/chat/native-session-view.ts:539`                                                                       | Replace history invalidation/replacement during a turn with direct event application.               |
| Worker history       | `services/gateway/src/methods/worker-session-history.ts:389`, `apps/command-center/ui/src/components/slot-view/worker-session-history.ts:122` | Remove subscription timers and full-message live refresh for native workers.                        |
| Default route        | `apps/command-center/ui/src/components/app-shell.ts:229`, `:924`, `:2592`                                                                     | Replace implicit fleet landing and separate copilot drawer with the main shared conversation entry. |
| Native observation   | `packages/agent-runtime/src/native/observation.ts:81`                                                                                         | Reuse journal observation; metadata receipts alone are not text delivery.                           |

The reference is [t3code at 67eebaca23f8f7bc46e8817434087fc9c5acf8e3](https://github.com/pingdotgg/t3code/tree/67eebaca23f8f7bc46e8817434087fc9c5acf8e3),
2026-11-05. Every reference link below pins that revision. Capability declarations
alone are insufficient; the links identify actual event handlers.

| Harness                       | t3code source and stream mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Farmslot baseline and parity requirement                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                        | [SDK partial messages enabled](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1843). The inspected [partial handler](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L8940) streams reasoning; [assistant text artifacts](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L8195) come from assistant block messages. This audit does not establish text-token delivery there. | `packages/agent-runtime/src/native/claude.ts:348` already forwards `stream_event/content_block_delta/text_delta`, with partial messages enabled. Keep actual text deltas; no downgrade or exception. |
| Codex                         | [App-server `item/agentMessage/delta`](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4400) appends assistant deltas.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `native/codex.ts:239` already normalizes the same event.                                                                                                                                             |
| Pi, including DeepSeek models | [RPC `message_update` / `text_delta`](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-pi/src/server/adapter.ts#L1778) schedules incremental items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `native/pi.ts:111` already forwards the RPC delta. DeepSeek is a Pi provider/model selection, not another transport.                                                                                 |
| OpenCode                      | [1.x `message.part.delta`](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-opencode/src/server/adapter.ts#L2497) from the server feed; [2.x `session.text.delta`](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-opencode/src/server/v2/adapter.ts#L2052).                                                                                                                                                                                                                                                                                                          | `native/opencode.ts:25` uses ACP. `native/acp.ts:170` normalizes `agent_message_chunk`. Same live text behavior is required; matching internal protocols is unnecessary.                             |
| Cursor                        | [Interaction `text-delta`](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-cursor/src/server/adapter.ts#L2000) appends and emits assistant segments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `native/cursor.ts` uses the shared ACP text-delta path. The old TUI limitation is not an accepted harness gap.                                                                                       |
| Grok                          | [Grok adapter](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-grok/src/server/adapter.ts#L347) uses [shared ACP `agent_message_chunk`](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-acp/src/server/adapter.ts#L5347).                                                                                                                                                                                                                                                                                                                                            | `native/grok.ts` uses the same shared ACP normalization.                                                                                                                                             |
| ACP registry                  | [Registry adapter](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/packages/provider-acp-registry/src/server/adapter.ts#L291) uses the shared ACP driver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Shared ACP exists; registry discovery/launch integration is missing. Match configured providers through the adapter/catalog boundary.                                                                |

Abbreviated Farmslot `native/` paths above are under `packages/agent-runtime/src/`.
Arthur's approved implementation scope requires live proof for the six installed runners. Kiro, FX, Antigravity and Muse/MSP were removed from planned parity on 2026-11-07. ACP remains: extend the shared client for an existing agent's ACP adapter, Claude Code first, including structured tools/diffs, Ask/deny/Bypass, model/effort, cwd and resume/stop in CC and Companion. Only the initial adapter is authorised for installation; no other CLI setup is implied. Contract tests are not live parity. See [the ACP client specification](native-acp-client.md).

T3 [thread subscriptions](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/apps/server/src/ws.ts#L845)
use WebSocket RPC. Its [bounded replay](https://github.com/pingdotgg/t3code/blob/67eebaca23f8f7bc46e8817434087fc9c5acf8e3/apps/server/src/orchestration-v2/ThreadStream.ts#L18)
permits 128 events and 1 MiB before choosing a bounded snapshot. Adopt the bounded
resume principle, not a second server. Farmslot MUST expose available text chunks
while a turn is running, without waiting for a paragraph or completed message.

## Transport and cursor contract

Use the existing authenticated client-to-gateway and gateway-to-node WebSockets.
No SSE endpoint, extra socket or direct browser-to-runner connection is required.
The native host MUST publish committed journal append ranges to the node transport.
Local and remote sessions MUST use the same feed. Observe append notifications
and read only the new range; do not stat or reread whole journals on a timer.

Operations, owned by `@farmslot/protocol/rpc/native-session`:

| Operation                    | Parameters                                                    | Result or event                                                                                         |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `native.session.subscribe`   | Existing `NativeSessionTargetParams`, optional `after` cursor | Opaque connection-scoped `subscriptionId`, current session metadata and either bounded replay or reset. |
| `native.session.delta`       | Server event only                                             | `subscriptionId`, ordered existing `NativeSessionEvent[]`, resulting cursor; or a terminal reason.      |
| `native.session.unsubscribe` | `subscriptionId`                                              | Idempotent removal on that authenticated connection.                                                    |

A cursor MUST contain the execution node, session ID, host generation and last
applied absolute sequence. Worker cursors MUST also include the existing run,
context and lease pin. The optional `after` here is this compound cursor, distinct
from `native.session.read`'s numeric `after`. Sequence numbers and event fields
MUST retain their existing journal meanings. Clients MUST deduplicate by source,
generation and sequence, never by text. Completion MUST NOT append text already
delivered in deltas.

Subscribe MUST establish its append listener before capturing an authoritative
journal high-water mark. It MUST deliver replay through that mark followed by live
events above it, with no gap or duplicate application. Queue live delivery until
the initial subscription result has been sent. A resume MUST replay at most
128 events and 1 MiB of encoded payload. A missing, ahead, obsolete-generation or
out-of-scope cursor MUST produce an explicit reset, never splice histories.

A reset MUST identify the current source, a consistent high-water sequence,
pending requests and command receipts, and a bounded recent timeline projection.
Cap its encoded payload at 1 MiB. It MUST expose a history cursor and truncation
state for older content and oversized tool results. Frame omissions MUST remain
readable through authorized journal pages. Existing source diagnostic omissions
MUST retain their explicit omission markers; this change cannot recover bytes the
runner or current journal never retained. The projection MUST include
the current assistant segment through that high-water mark, with a continuation
pointer if too large, so a mid-turn reconnect does not erase its prefix. New paging
MUST extend the existing native journal read machinery, not create another store.
Session, receipt and timeline data MUST describe the same journal boundary.

Live batches MUST preserve order and contain only new events, never the cumulative
conversation or cumulative assistant text. Flush pending text within 50 ms or
64 KiB, whichever occurs first. The batch cap is 1 MiB, including its envelope.
Adapters MUST split oversized text deltas before journaling, preserving every text
byte and assigning normal event sequences. Tool diagnostics keep the native host's
bounded diagnostic policy; do not add an unbounded content-transfer API here.
The queue per subscription MUST be bounded at 1 MiB. Overflow MUST close that subscription with `resync-required`;
its last applied cursor supports recovery from the journal. No silent drops or
unbounded buffering. A transport close uses the same recovery rule.

One visible conversation view MUST hold at most one logical subscription. Route
changes, backgrounding and unmount MUST release it. Multiple consumers of the same
authorized source MUST share one source tap and incremental reader, with individual
cursors and bounded queues. Stop that observation on the last unsubscribe. The
runner's necessary journal writes continue; idle viewing adds no timers, process
spawns, inference or whole-history scans. Any recent-timeline projection MUST be
maintained incrementally at the journal owner, with bounded initial hydration.
Do not rebuild it on each read or token. Cached history remains visible offline.
Reconnect MUST resubscribe only, never replay send/respond/create/close commands.

## Ownership and commands

Every subscribe and delivered batch MUST honor the current read authorization,
reader principal generation, node assignment and source identity. Revocation,
reassignment, session replacement or lost node authority MUST terminate the old
feed and evict denied cached content. The gateway evaluates read authorization once
per delivery pass over a recipient's queue. A pass emits synchronously, so no other
work runs between that evaluation and the updates it covers, and the reader and
source check still runs before each emit. Each update is serialized once to size the
queue and frame limits; recipients share that measurement. No events from a successor worker may leak
into an earlier pinned view. An owner-scoped source tap MAY be shared internally;
authorized recipients MUST be checked independently.

Standalone sessions, including the copilot, MUST preserve ADR-051 Amendment 6's
configured execution owner and server-derived requester. Worker and reviewer
sessions MUST use the existing pinned run/context/generation/lease read route and
its historical lease boundaries. Standalone delegation MUST NOT admit managed
workers. Released leases MAY be read only through their frozen historical window.
Do not manufacture a native session identity for a TUI process.

The stream is observation only. Sends, queued-message cancellation, interruptions,
approval/question responses and closes MUST use the existing native command routes,
command IDs, receipts and authorization. Managed worker input MUST retain its
worker control route. A reconnect is not native prompt acceptance. Approval cards
MUST bind the pending request and current process generation. Publication and merge
gates retain their separate operator authority; model output cannot confirm them.

Copilot fleet answers MUST use existing typed reads and observer evidence. Proposed
side effects MUST use the existing typed command/action and ADR-048 packet validators.
Human confirmation is bound to the displayed parameters; changed targets require
new confirmation. Observer annotations MUST NOT become synthetic conversation turns.
Memory configuration remains unchanged; no new memory writer is introduced.

## Public surface

All additions below shipped with live conversation streaming (#1894). Existing release/version policy
applies to protocol, node and native-host changes as one coordinated capability.
A gateway/native-host capability named `conversationStreaming` MUST advertise
support. An unsupported target stays visible with its reason; clients MUST NOT
fall back to polling or start a second runner. No compatibility service is retained.

- `@farmslot/protocol/rpc/native-session` owns the three operations, cursor,
  reset and capability contracts above. Consumers are gateway, node and native
  host transport, Command Center, Companion and the CLI.
- `@farmslot/protocol/client-cache` exports `observeNativeConversation`.
  It owns subscription lifetime, replay, incremental reduction, cursor and existing
  scoped-store integration. Consumers are the web and Companion view-models and
  the CLI follow command. Native timeline rendering stays shared; no per-platform
  parsers or independent transcript stores. Metadata stays on ADR-071 resource
  queries; native text MUST NOT invalidate those queries per token.
- Existing `copilot.status`, `copilot.start`, `copilot.stop` and `copilot.configure`
  retain singleton launch control. `CopilotRuntimeSession` MUST expose optional
  `nativeSession: NativeSessionTargetParams` when bound, replacing `tmuxTarget`,
  `terminalWorker` and `transcriptId`. Before launch, status supplies configuration
  without inventing a session. Consumers are the shared copilot entry and CLI RPC.
- The existing `farmslot rpc` command takes `--follow`, restricted
  to `native.session.subscribe`. It prints the initial result and subsequent
  stream envelopes as NDJSON, accepts the compound resume cursor in JSON params,
  and unsubscribes on Ctrl-C. No command is replayed. It extends `rpc`; there is no
  `native watch` command or other CLI family.
- Upper-layer harnesses such as mm-harness use the typed protocol client and
  `observeNativeConversation` for observing their pinned workers. Runner extensions
  emit existing normalized text/tool/request events through the native adapter
  contract. Protocol decoding, flags and launch semantics belong there, never in
  clients or task templates. No harness-specific stream flag or SDK model API.

## Cutover and removed paths

Implementation requires approval of this proposal. One implementation change MUST
move consumers before removing producers and MUST pass conformance before cutover.
It MUST leave one conversation writer and one live transport implementation.

Remove copilot raw `pipe-pane` transcript setup/decoding, `TRANSCRIPT_POLL_MS`,
`pollTranscript`, chat-body persistence and the `CHAT_RESPONSE` text producer.
Move callers off `chat.send`/`chat.history` and remove those routes and any unused
`chat.delta` contract, rather than retaining a second facade. Replace copilot
terminal-input delivery with native send/receipts. Keep typed observer evidence
separate from conversation bodies. Existing saved copilot chat and transcript
history MUST remain readable as immutable legacy history through the shared
controller. Do not keep the old mutable body writer. An active copilot MUST be
stopped only through explicit operator action. Bind a verified native saved session
or request an explicit fresh start; never silently replace it or replay its prompt.

Replace the native view's per-token history invalidation/refetch with incremental
stream reduction. Remove native worker history subscription timers and move its
consumers to pinned native subscriptions. Keep cached metadata observations,
authorized explicit history paging, and ADR-056 archive reads. These are reads,
not alternative execution or live-message implementations.

All new managed launches for the parity matrix MUST use structured adapters.
Existing TUI work MUST remain untouched, readable through its recorded transcript
or archive, and accessible through explicit Terminal. Live legacy history MUST use
an on-demand append observer, not the old subscription timer; completed-message
history MUST be labeled as such and MUST NOT count as token-stream parity. Historical
TUI data MUST retain its original identity. Native resume is allowed only through
existing verified saved-session resume; never silently transfer accounts, restart
active work or replay an uncertain prompt. No accepted harness exception or
completed rollout may be inferred from this temporary migration limitation.

ADR-002 Terminal diagnostics retain their own explicit byte subscription and
fallback. The shared chat MUST NOT open it in the background or use pane capture
as text, state or prompt-delivery evidence. Preserve ADR-047 historical access,
ADR-048 packets and ADR-056 archive retention.

## Completion checks after approval

The implementation MUST supply these results before it is called complete:

1. Live gateway proof for each of the six installed providers, in copilot/standalone and managed
   worker/reviewer roles where that role exists. Record executable/provider version,
   source event, normalized delta and visible text before turn completion. Existing
   unit adapters or a declared `streaming: true` alone do not prove parity. Missing
   credentials or adapters leave that row incomplete, not exempt.
2. A shared reducer regression covers multi-delta text, tool interleaving, completion
   without duplicate text, requests, generation/lease changes, ordered reconnect,
   a reset during an active turn, duplicate frames and bounded-queue overflow.
3. Real authenticated gateway and web/Companion checks prove default entry, launch
   in a slot and custom directory on another node, singleton reuse, authorization
   denial, offline history and no command replay. Existing deep links and archived
   TUI history remain usable. Worker/review ownership and publication are unchanged.
4. Measure at least 20 samples with the existing performance wrappers. Interactive
   reads MUST meet p95 250 ms and cached paint p95 100 ms. Received adapter text to
   rendered text MUST meet p95 250 ms, measured separately from provider first-token
   latency. Do not promise a model response within 250 ms.
5. Record bytes, source taps, journal bytes read, history RPCs and process spawns for
   one and multiple viewers. A 60-second idle window MUST add zero conversation-body
   polls, replay scans, process spawns or inference. An active turn MUST append deltas
   without whole-history reads. Last unsubscribe MUST leave no subscription-owned observer or timer.
6. Inventory and remove the old producers, timers and consumers named above. Verify
   that the UI/cache enforcement recognizes the live stream exception and that no
   copied component, alternate parser or second conversation writer remains.

Approval authorizes implementation planning, not a claim that these checks passed.
