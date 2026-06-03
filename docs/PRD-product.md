# Farmslot — Product PRD

This document is the canonical whole-product PRD for Farmslot. It defines the durable product boundaries that sit under [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and above the chunk contracts in the canonical PRD hierarchy.

## Product Definition

Farmslot is one product for operating, observing, and improving autonomous coding-agent work across a fleet of machines. It combines a shared execution framework, control surfaces, automation/intelligence loops, mobile oversight, and an evolving runner-neutral execution model into one coherent operator system.

## Primary User

The primary user is an operator supervising multiple autonomous coding agents across machines and slots. Farmslot should make that operator effective in three modes:

1. **Set up and dispatch work** through a shared framework and persistent control plane.
2. **Observe, intervene, and review** through desktop and mobile oversight surfaces.
3. **Improve the system over time** through automation, history, and intelligence-assisted loops.

## Canonical Product Chunks

| Chunk                                     | Canonical PRD                                                                        | What it owns                                                                                                        | Current state                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Core Farmslot                             | [PRD-core-farmslot-canonical.md](PRD-core-farmslot-canonical.md)                     | Pool/project model, slot lifecycle, hooks, task/artifact conventions, shared CLI/gateway execution substrate        | Framework and slot lifecycle foundations are shipped               |
| Command Center                            | [PRD-command-center-canonical.md](PRD-command-center-canonical.md)                   | Desktop control surface for fleet observability, dispatch support, slot workspace, PR/decision workflows            | Core command-center platform is shipped                            |
| Automation / Intelligence / Orchestration | [PRD-automation-intelligence-canonical.md](PRD-automation-intelligence-canonical.md) | Gateway-mediated run lifecycle, monitoring, automation, scoring, LLM-assisted orchestration, self-improvement loops | Major automation and intelligence layers are shipped and expanding |
| Mobile Companion                          | [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md)               | Native mobile oversight companion using the same gateway protocol                                                   | M1a-M4 shipped; M5 in progress                                     |
| Runner-Agnostic Execution                 | [PRD-runner-execution-canonical.md](PRD-runner-execution-canonical.md)               | Runner-neutral TUI-first execution contract, prompt handling, safety tiers, and recovery                            | Strategic product capability, still open                           |

## Product Requirements

### 1. Farmslot must stay one product

The framework, command surfaces, automation stack, mobile oversight, and runner model must remain legible as one operator product rather than separate tools with conflicting authority.

### 2. Product boundaries must be explicit

Whole-product scope lives here. Durable chunk contracts live in the canonical chunk PRDs. Long-form subsystem docs may elaborate, but they do not replace product ownership boundaries.

### 3. Historical truth must outrank summaries

Product planning may evolve, but ADRs and historical evidence stay intact. Derived summaries and current PRDs must reconcile against history instead of rewriting it.

### 4. Control surfaces must share a common backend truth

Desktop and mobile experiences should consume the same gateway/state model. Product surfaces may differ in depth and write capability, but not in their fundamental system picture.

### 5. Execution must remain operator-intervenable

Farmslot is built for supervised agent execution. Operators need visibility into slot health, lifecycle state, work progress, decisions, and recovery, whether they use the CLI, the desktop command center, or the mobile companion.

### 6. Automation and intelligence must improve, not obscure, the workflow

Automation, scoring, self-review, and self-improvement loops should reduce operator toil while keeping evidence, decisions, and escalation paths visible.

## Canonical Current-State Snapshot

- **Core Farmslot** already provides the slot/pool/project model, lifecycle scripts, task/artifact conventions, and the persistent gateway/CLI substrate.
- **Command Center** is already a major shipped product layer, not a speculative add-on.
- **Automation / Intelligence / Orchestration** is already part of the product through queueing, webhooks, monitoring, LLM-assisted flows, and co-pilot capabilities.
- **Mobile Companion** is not future-only: retained history in [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md), [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md), and ADR-033 records milestone delivery through M4 and M5/operator-control hardening.
- **Runner-Agnostic Execution** is a product-level capability whose contract must be shared across the rest of the system rather than treated as a command-center-only detail.

## Whole-Product Boundary Rules

- `docs/PRD-command-center-canonical.md` is not the whole-product PRD.
- `docs/PRD-mobile-companion-canonical.md` is not the whole-product roadmap or authority for other chunks.
- `docs/ROADMAP.md` may summarize product state, but chunk scope decisions belong here and in the canonical chunk PRDs.
- Cross-chunk decisions with architectural permanence should trace back to ADRs.

## Supporting Docs

Use these documents for chunk-specific scope and stable technical detail:

- [PRD-command-center-canonical.md](PRD-command-center-canonical.md)
- [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md)
- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- [ADR index](adr/README.md)
- [reference/](reference/)
- [operations/](operations/)

## Pass-One Normalization Decisions

- Treat the mobile companion as an active product chunk with shipped scope through M4 and current work in M5.
- Treat the command center as a chunk within Farmslot, not as the whole product.
- Treat runner-agnostic execution as a cross-product platform capability that other chunks depend on.
- Treat ADR-026 and ADR-027 as part of the active architecture inventory even though the ADR README is stale.
