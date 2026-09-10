# Farmslot — Command Center Canonical PRD

This canonical chunk PRD defines the Command Center within the Farmslot product hierarchy described by [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It is the authoritative chunk contract for the desktop control surface.

## Scope

The Command Center owns the desktop control surface for supervising and interacting with a running farm:

- fleet overview and slot status visibility
- dispatch support and lifecycle actions exposed through the gateway
- live observability into agents, terminals, progress, artifacts, and device feeds
- slot workspace and PR/review workflows
- operator-facing decision and triage surfaces

## User Outcome

An operator should be able to supervise multiple agents from one persistent visual surface instead of managing the entire fleet through one serial chat or a pile of terminal windows.

## Canonical Current State

- The command-center product layer is already shipped as a major Farmslot capability.
- The platform includes fleet visualization, slot observability, workflow orchestration, PR/CI surfaces, and a slot workspace.
- Supporting shipped history remains in `docs/IMPLEMENTED-HISTORY.md`, `docs/ROADMAP.md`, and the ADRs.
- The approved next command-center slice is the Slot Recipe Quality Cockpit (PRD/test spec dated 2026-04-21), which unifies recipe presentation across `review-workspace`, `family-observability`, and `slot-view` without changing host ownership boundaries.

## Requirements

### 1. Gateway-backed control surface

The Command Center must act as a client of the shared gateway/state model rather than inventing a parallel orchestration path.

### 2. Fleet-first observability

Operators need continuous visibility into slot health, lifecycle state, task progress, decisions, artifacts, and review status across the fleet.

### 3. Structured operator actions

Common actions such as dispatch support, lifecycle control, review triage, and decision handling should be available as structured UI workflows instead of requiring ad hoc shell navigation.

### 4. Workspace depth when needed

The chunk must support drill-down into a slot's working tree, diffs, artifacts, and live terminal context when high-touch intervention is required.

### 5. Runner-model consumer, not owner

The Command Center consumes the shared runner-execution model. It must not redefine runner behavior ad hoc for one UI surface.

### 6. Monitored PR queue (planned)

Provide the desktop subscription and incident controls defined in [persistent PR monitoring](PRD-automation-intelligence-canonical.md#6-persistent-pr-monitoring-planned). Operators can add any accessible PR, including external PRs by other authors, choose notify-only or automatic repair, and see freshness, the reason attention is needed, and linked queued/running repairs. This queue remains usable without active runs or slots. Actions and policy changes use gateway authority and update other clients immediately.

### 7. Trigger rules and review intake (planned)

Reuse the existing Continue/Fresh and static/full-live review controls. Show the saved reviewer session, prior reviewed SHA and actual continuation or fallback outcome. A selected slot pool can rotate among PRs and later reload a previous reviewer for an incremental follow-up. Configure whether a busy compatible reviewer waits or allows a fresh start elsewhere.

Provide the source/field binding editor, dry-run match preview, activation/backfill controls and review queue for [declarative trigger rules](PRD-automation-intelligence-canonical.md#7-declarative-trigger-rules-and-review-intake-planned). Show held review intake separately from automatically admitted work, with rule/fact provenance and missing-project or permission explanations. Provide reusable team profiles across GitHub Projects and repositories, with team filters, configurable review policies and authorized notification audiences. Show GitHub review/CI facts separately from Project workflow fields and inferred owner suggestions. Allow each review rule to select one slot or a list of allowed slots, plus runner/model/effort choices through an execution profile. Preview compatible combinations and show requested versus actual assignments, capacity waits and configuration conflicts.

## Boundaries

- This document is the canonical command-center contract.
- Mobile scope belongs to [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md), not to Command Center.
- Whole-product ownership and cross-chunk boundaries live in [PRD-product.md](PRD-product.md), not here.

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md)
- [ADR index](adr/README.md)
- `apps/command-center/ui/src/dev/dev-harness.ts` for host-parity validation entry points (`slot-view`, `review-workspace`, and `family-observability`)
- ADR-001 through ADR-018 where applicable, especially ADR-011, ADR-012, ADR-013, ADR-016, and ADR-017

## Success Condition for This Chunk

The Command Center gives one operator a reliable, persistent, multi-slot supervisory surface that reflects shared backend truth and supports intervention without becoming the only source of product authority.
