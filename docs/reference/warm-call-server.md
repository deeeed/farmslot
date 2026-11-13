# Warm call server

**Status:** Proposed specification for [ADR-072](../adr/072-warm-call-server.md).
**Owner:** Arthur / Farmslot.
**Approval:** Lead and Arthur approval are pending. Do not implement this specification until both approve the same revision.
**Document purpose:** Stable execution contract supporting the Core Platform PRD through ADR-072. Separate from the decision so request, invalidation and proof requirements have one home. Keep with its ADR; contains no host-specific configuration or private evidence.

## Ownership and initial scope

`@farmslot/recipe-cli` owns admission, identity, preparation reuse, execution and
timings. `@farmslot/recipe-runner` retains graph execution, evidence and transport
ownership. Harnesses supply host, adapter and lifecycle configuration. Slot
release and recycle invoke shared shutdown through the existing lifecycle owner.

The capability serves `call` and `run` through the existing shared engine.
Lifecycle commands and discovery remain on their existing paths.
Proposed `--execution-mode=auto|cold` on both commands selects lazy
server use or the existing cold path, with `auto` the eventual default only after
acceptance. Unsupported invocations use the cold path before submission. No
new public daemon command, gateway RPC or network service is required.

## Identity and admission

One owner claim is keyed by canonical checkout realpath. Its generation binds
the resolved slot, product host and installed executable identity. Linked
worktrees are distinct even when they share a Git common directory. Reject a
request whose binding does not match; two slot identities cannot start competing
servers for the same checkout. Changing a slot's checkout, installation or host
configuration retires the old process before admitting work on the new binding.
Calls without a resolved slot stay cold.

Use a local Unix socket in an owner-only runtime directory, with an exclusive
startup claim and a generation nonce. A stale PID or socket alone does not
establish ownership. Verify the generation and process identity before signalling
or reclaiming it. Simultaneous first calls must establish one owner. Enforce the
existing slot lease and source/authority checks; a socket is not authorization.

Allow one active execution. A second call receives a busy refusal before
acceptance and does not bypass that refusal through the cold path. Stop and
release close admission first. They cancel through the normal execution signal,
wait for cleanup, close transports and remove only their own generation's files.
Forced termination leaves the operation indeterminate and preserves its files.

## Request contract

Each invocation creates a unique operation ID and artifacts directory using the
existing allocation rules. The bounded, versioned request carries that ID,
identity, command arguments, resolved caller context, deadline and the execution
environment the cold path would use. Do not serialize closures or reuse ambient
environment from an earlier caller. Secrets remain local, use the existing
redaction rules and never appear in server identity or discovery records.

The client negotiates identity and protocol compatibility before submitting work.
After validation, the server records acceptance in the operation's runtime
journal before any action can execute. Responses distinguish refused,
accepted/running, terminal and indeterminate. Terminal output contains the same
result, error, exit status and artifact paths as a cold invocation. Repeated
operation IDs return known status or terminal output; they never execute again.
Status lookup must survive a server restart through the existing journal and
evidence, without asserting success when finalization is incomplete.

The client may fall back before sending the execution request, or after a
compatible server explicitly refuses as unsupported and guarantees no acceptance.
It must not fall back on busy, authorization or provenance refusal. Once it sends
execution bytes, lost acknowledgement, timeout or server death is indeterminate.
Inspect the journal and evidence; do not automatically resubmit through either
path. This deliberately prefers an explicit unknown outcome over a duplicate
mutation.

Cancellation identifies the operation and server generation. Client disconnect
cancels that request, preserving the cold invocation's cleanup behavior. It must
not kill a later request. An action failure returns its original error; ordinary
proof actions gain no hidden app restart, reload, reconnect or retry.

## What can stay warm

Imported framework code and validated immutable manifest/library data may stay
warm. Reuse a runner only when its full construction inputs match, including
action sources and trust, host/adapter identity, HUD/recording policy, observer
configuration and mutation authorization. Never carry an authorized mutation,
plan, task context or request-bound callback into another call. If a runner holds
request-bound state, reuse only its immutable preparation and construct the
request-bound part afresh. At most one runner build and one plan per ordinary
call remain the count guard.

Every request starts new environment and context scopes, timing counters,
execution state, observers, diagnostics, cancellation, recording leases and
artifact writers. Restore environment and close request resources on success,
failure and cancellation. The current process-global host/adapter registries,
Git top-level/origin caches and any library/adapter module state require an audit:
bind them to the server identity, revalidate them or discard them per request.

Connections may persist only with their exact device, runtime session and
endpoint identity. Validate that identity before use and stop on disconnection.
Do not reuse route probes, screenshots, issues reads, HUD updates or device
descriptions. Each observation still occurs at the original point in execution.

## Invalidation and provenance

Use the current fingerprint functions and input-selection rules. Do not create
a weaker parallel cache based only on versions, mtimes or watcher notifications.
Validate the selected inputs before each request. Changes between requests
invalidate preparation and trigger fresh resolution, rather than invalidating a
new request solely because the previous one saw different bytes.

| Input                  | Required validation                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product checkout       | Current source selection, HEAD, tracked/untracked content and configured exclusions. Preserve relative-root, symlink, rename, submodule and non-UTF-8 behavior. |
| Manifest and libraries | Ordered source roots, source bytes, trust-adjusted sources, provenance and current authorization/source receipts.                                               |
| Live adapter bundle    | Existing bundle input digests, absent inputs, directory existence, package resolution files and nearer dependency candidates.                                   |
| Executable packages    | Runner delivery bytes, host/package installation, dependency resolution and Node/toolchain identity used by preparation.                                        |
| Recipe and helpers     | Current recipe digest and command-helper fingerprints for this request.                                                                                         |

Watchers may trigger eager invalidation but cannot establish unchanged inputs.
When executable imports change, retire the generation before accepting a request;
changing a cache entry does not evict Node's imported modules. An input that
cannot be validated takes the existing full calculation or cold path before
submission. It never becomes an assumed cache hit.

Each request captures `start` before freezing its executable preparation,
`pre-execute` before actions and `end` at finalization through
`captureExecutionProvenance`. Reuse the same functions for fingerprint selection,
`executionProvenanceDrift` and refusal. A cached runner's bytes must match that
request's start snapshot. Validate cached executable inputs after `start` and
before `pre-execute`; a check before `start` alone leaves a race where the
snapshot records new source while an old bundle executes. Discard mismatched
preparation and rebuild under the same provenance checks. Changes during
preparation or execution keep the current `PROVENANCE_DRIFT` behavior and invalid
evidence record.

## Evidence and measurement

Preserve `trace.json`, summary, artifact manifest, `execution-provenance.json`,
`call-timings.json` and the existing stdout/JSON and exit-code contracts. Every
served request, including a recipe run, writes its request timing artifact;
the explicit cold mode does the same for comparison. Evidence
is finalized per request, never accumulated across the server's life. Retain
partial files after interruption and do not report a terminal success until the
same cold-path finalization has finished.

The existing timing schema starts at process birth. Introduce an explicitly
versioned request-timing schema before using it in a persistent process. Proposed
schema 2 keeps the current fields but defines `wallMs`, `cpuMs`, phases and counts
as request deltas, and records `executionMode` as `cold` or `warm`. Schema 1 remains
readable with its original meaning. Record cold startup separately so CPU and
process savings do not disappear outside the request counter. Serial execution
avoids overlap but does not by itself exclude idle/background server work;
attribute child processes through the existing request context and document the
CPU measurement boundary.

The external measurement captures whole-command wall and client process-tree CPU
as well as the server's request CPU and children. A persistent server is outside
the client's process tree: shell `time` alone cannot prove total CPU savings.
Report both contributions and their combined total without double-counting a
cold child. Count client and server process starts too. Store shell wall minus
internal wall as the wrapper/client gap. Keep startup, invalidation and steady
warm samples separate. Never compare server uptime with a cold call or rename a
workload to make a regression pass.

## Acceptance proof

Before a live run, obtain a quiet slot allocation from its owner and check that
no other run occupies it. Keep the same package, source state, recording policy
and host load for cold/warm pairs. Save raw artifacts and host/build identity.

1. Measure `ui.screenshot`, `metamask.perps.read_positions` and
   `metamask.wallet.ensure_unlocked`, plus the established Extension and Core
   calls, cold and warm. Keep first-start samples separate; compare at least five
   steady samples by median external wall, CPU, internal phases and counts.
2. Run the same five-node recipe cold and warm with matching recording policy.
   Verify action results and evidence, including request timings and recording
   output. Keep startup, repeated requests and per-node action costs distinct.
3. Pass existing provenance refusal tests and exercise edits between requests,
   after preparation and during execution. Include manifest/library/helper and
   ignored delivery changes, dependency resolution changes, absent inputs,
   relative roots, exclusions, symlinks, renames, submodules and non-UTF-8 paths.
4. Prove first-call races, distinct slots/worktrees, changed trust/context,
   environment cleanup, timeout/cancellation and stop/release/recycle. Crash before
   submission, after acceptance and during a mutation; prove no automatic replay
   and that partial evidence remains inspectable.
5. Pass per-adapter count budgets and the existing bridge reliability contracts.
   Feed accepted measurements into the existing full-flow canary. It alerts on a
   median wall or CPU increase above 20%, or any count increase, against comparable
   release/workload baselines.

Approval authorizes design only unless it also names implementation scope.
Default enablement additionally requires live proof, reviews of the same head,
green relevant CI and the normal release process. No server code is part of this
proposal.
