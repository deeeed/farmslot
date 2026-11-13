# ADR-072: Warm recipe call server per slot

**Status:** Proposed
**Date:** 2026-11-13
**Owner:** Arthur / Farmslot
**Approval:** Lead review and Arthur's explicit approval are required before implementation. Neither approval is recorded.
**Delivery:** Design only. No server implementation, package release or rollout is authorized.
**Specification:** [Warm call server](../reference/warm-call-server.md)
**Document purpose:** Canonical architecture proposal supporting the [Core Platform PRD](../PRD-core-farmslot-canonical.md), [ADR-034](034-recipe-protocol-v1.md) and [ADR-062](062-recorded-run-evidence.md). A new record covers a persistent execution process, which existing recipe and evidence decisions do not define. Keep this public-safe decision and its specification together; reject or accept them together.

## Context

A cold `call` starts Node, imports the CLI, resolves libraries and action manifests,
constructs a runner and opens bridge connections for one action. The action can
take less time than that preparation. Existing bundle caching avoids repeated
bundling but still starts a process and checks inputs on every invocation.

A long-lived process could remove repeated preparation. It also removes the
process boundary that currently clears module state, environment, trust and
timing counters. Reusing a stale runner would make evidence misleading; retrying
after a lost response could repeat a mutation.

## Decision proposed

The shared recipe CLI owns one optional local call server per resolved checkout
and slot identity. Product harnesses configure their host and adapters through
the existing extension points. They provide no separate executor. The server
handles `call` and `run` through their existing shared execution engine. Lifecycle
and discovery commands stay on their existing paths.

The first call starts the server lazily. An existing launch may prewarm it without
executing an action. Stop, slot release and recycle stop its admission, finish or
cancel the active request through existing cleanup, then close the process.
Requests execute serially. Existing slot ownership and authorization apply to
both server and cold execution.

Keep imported modules, validated immutable manifests, bundles and compatible
runner configuration warm. Each request gets fresh arguments, environment,
authority, plan, execution state, artifacts and provenance snapshots. Persistent
transport may reuse a connection only after checking its endpoint identity.
Every UI read retains its original execution point.

Before reuse, validate the existing source and bundle fingerprints, including
resolution inputs and absent paths. A changed input invalidates preparation;
changed executable modules require a new process generation. Recheck trust and
source receipts for each request. Keep the start, pre-execute and end provenance
checks. Drift after preparation still refuses or invalidates execution.

Cold fallback is allowed only before execution submission or after an explicit
refusal that guarantees no execution was accepted. A timeout, disconnect or crash
after submission is indeterminate and must never trigger automatic replay.
Preserve available evidence and report the operation identity for inspection.

Return the same output, exit status and evidence files. Version request-scoped
timings explicitly; server uptime must never become a call's duration. Measure
external wall time separately so client and wrapper costs remain visible.

## Alternatives

| Option                                   | Trade-off                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Keep the cold path only                  | Simplest isolation; repeated process and resolution costs remain. Keep it as fallback and an explicit diagnostic mode. |
| Lazy imports alone                       | Reduces startup work but leaves manifest, runner and connection setup. Prefer this if the server proposal is rejected. |
| One server for a host                    | Shares more work but crosses checkout, slot and product-host state. Rejected.                                          |
| Reuse a prepared plan or UI observations | Could skip work, but changes authorization or evidence moments. Rejected.                                              |

## Consequences and approval questions

Process lifetime becomes a managed slot resource. Request isolation, invalidation,
crash handling and timing attribution need contracts before speed claims are
credible. The current host registry, environment scopes and Git metadata maps
assume a short-lived CLI and need an explicit lifetime audit.

Approval must confirm the `call` and `run` scope, serial admission, cold-mode
control, request-timing schema change and no-replay crash rule in the
[specification](../reference/warm-call-server.md). The anticipated saving is a
hypothesis, not an accepted latency target. Publish measured cold and warm results
before enabling the server by default.
