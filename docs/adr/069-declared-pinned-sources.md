# ADR-069: Declared and pinned farm sources

**Status:** Proposed
**Date:** 2026-10-12
**Owner:** Arthur / Farmslot
**Scope:** Decision and [normative specification](../reference/declared-pinned-sources.md) only. Implementation requires acceptance and a separately approved implementation PR.

## Context

Project packs, recipe libraries and helper repositories currently reach execution
through gateway checkouts, deployment copies and configured checkout paths.
In-place changes and leftover branches make a repository name insufficient to
identify what a node executed. Deployment-time copying also leaves source
updates coupled to service deployment. External synchronization scripts cannot
give every run an authoritative source receipt.

This decision extends [ADR-068](068-project-recipe-binding-and-conformance.md)'s
declared executable-source trust, [ADR-062](062-recorded-run-evidence.md)'s
provenance and [ADR-065](065-fail-closed-run-lifecycle.md)'s admission rules.
Application worktrees, runtime artifacts and published package installation
remain under their existing owners.

## Decision

Every pack, recipe library and helper repository is a declared source with a
stable ID, repository identity and ref. The default ref is `main`. The gateway
resolves those declarations and scoped branch pins into exact commits and
publishes complete, versioned source locks. Branch-tracking refs auto-advance;
an admitted run keeps its original lock even when a branch moves.
Resolution records are versioned independently per source/ref. Each lock covers
one admission context and selected dependency closure, so an unrelated source's
failure cannot prevent a complete, current closure from being admitted.

Nodes materialize the locked commits into immutable, read-only source trees
before admission. They report the expected lock, actual commits and integrity
receipts. Missing, unknown, substituted or dirty sources prevent new work.
Declared updates create new materializations rather than replacing inputs under
an active run. Gateway-side pack loading uses the same locked-input rule.

Experiments require a pushed branch pin. Pins apply to one run, one node or the
farm, with run over node over farm precedence per source. Each pin shows its
scope, branch and base main commit. Unpin returns that scope to main; it does
not reveal a hidden broader experiment. Local paths and dirty snapshots cannot
serve as pins. Node-specific values stay in pool placeholders.

Materialized files are never migration destinations. Schema changes land in
upstream source PRs or use versioned load-time conversion without rewriting
files. Run and evidence records retain the exact source commits and pin context.
Historical records without reliable source facts remain unknown with their
original provenance intact.

Delete deployment-time pack rsync, stale node project copies and operator-side
source-sync scripts after the new admission path and its consumer mappings pass
fleet acceptance. Keep node service deployment separate. The cut-over has no
compatibility shims or fallback to loose checkouts.

## Public surface

The [specification](../reference/declared-pinned-sources.md#public-surface) defines
`farmslot sources status | sync | pin | unpin`, scope selectors, RPCs and SDK
exports with their consumers. The family manages source inputs; recipe actions
remain under the existing single `farmslot recipe` family.

`@farmslot/protocol` owns source declarations, locks, pin/provenance DTOs, RPC
contracts and one shared source-status view-model and validation. The gateway,
node, CLI, Command Center, Companion and harnesses consume that contract.
`@farmslot/slot-config` owns source-binding resolution for existing config/hook
consumers. Command Center and Companion provide only thin platform renderers;
all source configuration views reuse the same model and context-aware picker.

Harnesses declare source dependencies and repository-relative entry points.
They inherit resolution, materialization, drift checks and provenance rather
than implementing independent synchronization or version selection. Source
availability does not authorize executing a provider or grant resource leases.
These additions are proposed, versioned surfaces, not claims of shipped APIs.

## Alternatives considered

| Alternative                                         | Reason rejected                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Continue deployment rsync and external sync scripts | No authoritative execution lock; updates remain tied to deployment and can replace live inputs.     |
| Each node follows branches itself                   | Nodes can resolve different commits for the same run.                                               |
| Commit-only declarations                            | Reproducible, but prevent the required automatic branch advancement; exact commits belong in locks. |
| Local-path or dirty-snapshot pins                   | Hide unpublished inputs and fail to reproduce on another node.                                      |
| Edit or migrate cached source files                 | Creates undeclared drift and destroys the relationship to upstream commits.                         |

## Failure modes and consequences

The spec defines offline admission, per-repository/private authentication,
force-pushed branches, partial fetches, write protection and pin races. Failures
retain the last complete lock and diagnostic state, without treating stale or
unknown inputs as current. Ongoing runs retain owned resources and immutable
inputs under ADR-065; a source update does not restart or kill them.

The gateway becomes the source-lock authority. Content-addressed caches and
retention of run-referenced commits cost storage. Branch advances can introduce
new reviewed source behavior, but cannot silently alter existing run inputs.

## Migration and acceptance

Inventory every pack, library, helper and loader first. Move intended local
changes upstream; declare clean repositories and refs; replace checkout-path
bindings with source IDs. Materialize and compare locked inputs on gateway and
nodes before enabling fail-closed admission. Preserve active runs until their
owned work finishes. Validate the migration matrix in the spec, then delete all
superseded copies and source-sync mechanisms in the implementation cut-over.

Arthur's acceptance of this ADR is required before implementation. This docs PR
neither deploys the source manager nor converts any live checkout.
