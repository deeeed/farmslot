# Node link protocol

This is the normative infrastructure contract for [ADR-008 Amendment 3](../adr/008-remote-communication.md#amendment-3-persistent-typed-node-link-2026-11-07). Keep this reference with the shared protocol and node conformance tests. Implementation support is advertised per operation; documenting an operation does not advertise its availability.

The node service owns one outbound authenticated WebSocket to the gateway, including on the gateway machine. Extend that service. Do not create another daemon or connection. Providers stay on nodes. Workers do not become gateway clients. Tmux remains the default runner transport. This contract does not implement a native agent loop.

## Registration and authority

Use the [declared peer compatibility policy](node-worker-cli-health.md#peer-version-compatibility). Both `node.connect` and its successful reply carry `protocolVersion`, `minimumProtocolVersion`, `runtimeVersion`, and `minimumRuntimeVersion`. That reference owns their validation and compatibility rules. Do not add version equality checks here. Operation capabilities and retained-input gates remain separate requirements.

An enabled node advertises `nodeLink: { commands: 1, streams: 1 }` only for implementations passing the corresponding conformance cases. Its successful registration identifies the accepted link capabilities and bounds. Missing declarations mean unsupported, not a protocol break. A known command with missing capability fails before admission. It does not fall back to another transport.

The gateway derives requester, configured executor, execution target, approval and grant from existing authenticated routing and lifecycle owners. Clients cannot supply delegation identities or manufacture grants through this envelope. A command never changes run ownership, native ownership, review authorship or publication identity.

Bind every admission to the current authenticated node socket. Retire a superseded socket before admitting work on its replacement. An old socket may confirm its own outstanding closeout, but cannot admit another command or publish into its successor's stream. Credential revocation stops admissions and observations immediately. Existing cleanup owners retain responsibility for resources whose closeout remains uncertain.

Use TLS outside loopback or an explicitly protected transport. Credentials are exchanged through the existing authentication flow and never included in command payloads, receipts, URLs or diagnostics.

## Commands

A PTY process emits a structured `started` frame, then ordered output. Its receipt remains unsettled until the attached client exits. `node.link.terminal.resize` checks the original command authority and bounded dimensions. Input uses the existing numbered terminal writer; attachment and reconnect never replay keys. Detaching a tmux client leaves its worker and conversation running.

Carry commands inside the existing `req`/`res` frames. The outer request ID correlates one network exchange; it is not the idempotency identity.

| Method                | Purpose                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `node.link.authorize` | Bind a server-derived resource grant on the current socket; replacement revokes queued old work |
| `node.link.status`    | Confirm the registered feature is ready before granting work                                    |
| `node.link.release`   | Release a settled command's observation/grant resources, preserving its durable receipt         |
| `node.link.command`   | Validate, durably admit and execute one typed operation                                         |
| `node.link.receipt`   | Read an existing outcome under current authority, without executing                             |
| `node.link.cancel`    | Persist cancellation intent and request authored teardown                                       |
| `node.link.resume`    | Resume an authorized stream at a contiguous applied cursor                                      |
| `node.link.ack`       | Release acknowledged stream credit                                                              |

A command contains these fields:

| Field       | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `commandId` | Caller-retained unique key, stable through delivery uncertainty |
| `operation` | A discriminant in the shared operation registry                 |
| `target`    | Execution node and scoped resource identity                     |
| `authority` | Server-derived requester, executor, grant and approval receipt  |
| `lease`     | Run/context/lease/generation fence when the resource is leased  |
| `expiresAt` | Fixed admission deadline, not extended by retry                 |
| `input`     | The operation's validated parameter type                        |

Validate unknown input at the node boundary. Reject unknown fields that could widen authority, unknown operations, oversized frames, malformed identities and invalid bounds before recording admission. Canonicalize accepted input once and hash the operation, target, authority, lease, deadline and input. Never persist secret environment values or prompt bodies in audit metadata.

A grant names permitted operations and resource scope. File grants resolve through the existing admitted root and symlink policy. Process grants bind executable/argv policy or a frozen script reference, source digest, cwd, approval and resource limits. The existing framework command builders may retain their generated commands as exact approved argv, including their current noninteractive shell wrapper. This exception does not add a shell parameter to any UI or public launch contract. The node compares the complete argv, cwd, environment class and limits with the server-derived grant before execution. New operations use named adapters or admitted script references; uploaded bytes alone confer no execution authority. Frozen hooks resolve from verified project/source bundles already admitted on the node; uploading bytes or naming their hash does not authorize them. Resolve mutable selectors before admission and retain the exact source identities in the receipt.

The shared registry covers these operation families. Each adapter declares its supported subset and validates its own inputs and results.

| Family                         | Required behavior                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Dispatch and prepare           | Exact frozen inputs, expected worker/resource lease, existing launch acceptance evidence                       |
| Capture and inspect            | Explicit target identity, bounded result, source/frame identity; cached results labelled separately            |
| Files                          | Root confinement, content/hash preconditions, bounded ranges, transfer integrity and explicit replacement      |
| Process and signal             | Policy-checked argv or frozen script reference; target process identity, bounded output, deadline and closeout |
| Release                        | Authored resource cleanup with owner/generation fences; no ownership release before confirmed closeout         |
| Browser, device and dev server | Existing provider capability and resource lease; no client-chosen host or device substitution                  |
| Tools                          | The session's existing ask/bypass policy, permission receipt and audit trail                                   |

The generic registry has no tmux pane fields or CLI transcript fields. Local adapters may translate a generic resource reference into their private tmux, SDK, browser or device mechanics.

## Durable receipts and uncertain delivery

Before side effects, persist an admission receipt atomically. Serialize competing admissions for the same authority-bound command key. A duplicate with the same canonical hash observes the same execution and receipt. The same key with different input, scope or deadline fails with `IDEMPOTENCY_CONFLICT`.

Receipts distinguish `admitted`, `running`, `cancel-requested`, `completed`, `failed`, `cancelled`, and `unknown`. A terminal receipt includes outcome and confirmed closeout evidence. A definite refusal before admission is distinct from a failure after admission. Persist terminal outcome before acknowledging it.

On disconnect or timeout, the caller has an uncertain outcome. Query the same receipt after reconnect. Do not send a replacement command or replay an admitted operation. A process restart that finds unfinished admission marks it unknown until its original process/resource owner reconciles it. Missing or expired retained outcomes also require reconciliation; absence is not proof that execution never happened.

Cancellation acknowledgment means intent is durable. It does not mean the process, descendants, file transfer or provider resource stopped. Signal the original execution identity, wait for its authored teardown and record closeout. Keep its lease while closeout is unknown. Repeated cancellation cannot signal a reused PID or a successor's resource. An expired or replaced effect grant does not revoke cleanup of its exact already-admitted command: the current enrolled peer must still match the original command digest and executor identity. That closeout path cannot admit another effect.

Reject a new admission after its fixed deadline. Check expiry again immediately before starting a queued operation. Use a local monotonic timer once admitted. If clock uncertainty prevents establishing a valid admission deadline, refuse admission rather than extending it on reconnect.

Retain command keys and outcomes through their declared validity and reconciliation windows. The pilot retains at most 4,096 receipt-directory entries and fails closed when that store is full. Settled keys are not silently evicted to make another admission fit. Never evict an uncertain command or reuse its key to reclaim capacity. Expiry cleanup may remove settled payloads only when their keys can no longer admit execution; keep sufficient tombstone/expiry evidence to prevent replay.

## Streams and transfers

Node infrastructure envelopes are distinct from ACP. Reuse ACP for agent-facing session updates, message deltas, tool calls/results, diffs and permission requests, mapped through the existing shared native projections for both clients. Preserve model, effort, cwd, resume/stop and per-session approval mode. Bypass decisions are explicit audited decisions. Do not infer them from a transport reconnect.

Every stream envelope contains `streamId`, source `incarnation`, authority/lease identity, and monotonic `offset`. Offsets identify contiguous application units within that incarnation, not exactly-once side effects. A receiver applies each unit once and acknowledges the highest contiguous applied offset, never the highest merely received offset.

Retain a bounded indexed replay window. Resume from the acknowledged cursor without rescanning a journal. A missing interval, replaced source, changed lease or expired cursor returns an explicit reset reason and bounded snapshot with its new cursor. Consumers replace the projection atomically; they do not splice histories or silently skip gaps. If an available snapshot cannot represent a stream safely, surface resynchronization failure instead of truncating without notice.

File transfers additionally bind source identity, expected length and content hash. Chunks carry byte ranges and integrity evidence. Resume only against the same source incarnation and destination transfer identity. Verify the whole object before exposing its committed destination. Restarting an uncertain write under a new command key is forbidden. Existing read-only retry policies do not authorize repeating mutations.

## Bounds and scheduling

Negotiate finite limits during registration. Each sender enforces the lower accepted bound before queuing bytes; the receiver enforces it before dispatch. Keep metadata and bulk credit separate.

The pilot ceilings are one MiB per wire frame, 64 KiB per bulk chunk, eight MiB queued per connection, 32 admitted in-flight operations, and 256 KiB queued per stream. Reserve eight operation slots for control and interactive work. These are ceilings, not permission to buffer an entire artifact. Apply smaller existing operation limits where required. Report refusals and dropped/resync counters without private payloads.

Schedule cancellation, acknowledgments and control ahead of bulk. Yield between bulk chunks. A slow consumer exhausts its own credit, then receives an explicit reset or backpressure refusal; it cannot grow an unbounded queue or stall unrelated controls. Bound output from processes and capture producers too.

One TCP connection still has head-of-line blocking. Measure interactive latency while a large transfer is active. Priority queues cannot retract a frame already written to the socket. Do not claim isolation without that measurement.

Reconnect with exponential backoff and jitter. Retire the old socket generation and reconcile receipts before resuming authorized streams. Do not restart workers merely because infrastructure reconnects.

## Audit and errors

Record requester/executor identities and generations, command/grant/approval IDs, operation, target, lease/generation, argument digest, admission, outcome and closeout. Keep existing review/publication receipts authoritative. Diagnostic series use bounded labels and contain no credentials, private command text or file contents.

Use structured errors for disabled/unsupported capability, invalid input, stale authority/socket/lease/source, expired admission, idempotency conflict, capacity/backpressure, uncertain outcome and resynchronization. A retry hint may suggest reading a receipt or reconnecting. It cannot authorize replaying an uncertain mutation or switching to SSH.

SSH is only for bootstrap/upgrade or an explicit audited operator fallback. A failed node request must not silently invoke SSH. For AC-3, zero SSH means the farm's node-control transport; git/VCS and tools an agent runs that use SSH stay allowed and are counted separately.

## Pilot and conformance

Default off. Set `env.FARMSLOT_NODE_LINK_ENABLED` to `"1"` in one idle node's canonical `pool/<machine>.json`, stage that matching configuration with the reviewed node service, and verify its capability gate. Omitted or `"0"` stays off. The gateway and node read the same setting. Persist the gateway's routing policy independently of socket liveness, so an offline pilot cannot silently revert to SSH. Flag-off preserves the existing supported transport; it does not change tmux defaults. Rollback requires a fresh drain and explicit operator decision while retaining uncertain receipts and journals.

Before enabling an operation, its real adapter must pass:

- Compatible newer/older declared peers connect; a declared break refuses before admission and preserves healthy registrations.
- Missing capability and disabled flag refuse safely; old/superseded sockets, revoked authority and stale leases cannot act or stream.
- Concurrent duplicates execute once; changed keys refuse; restart/disconnect/timeout query the same receipt without replay.
- Expired queued commands do not start; cancellation does not release ownership before process/resource closeout.
- Contiguous replay deduplicates; gaps, replacement and expiry reset explicitly from a bounded indexed snapshot.
- Slow consumers and full queues remain bounded; cancellation and interactive work progress during bulk transfer.
- Root/source/argv/approval fences hold; review and publication identity do not change.
- The [measurement workload](../plans/node-link-measurements.md) repeats with the same declared parameters, scope and cache state. Report SSH categories separately and leave unavailable measurements explicit.

The deployment owner coordinates matching reviewed source, packages, nodes and GUI readers. This flag is not permission for another activation or for restarting live workers.
