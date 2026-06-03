# Farmslot — Runner-Agnostic Execution Canonical PRD

This canonical chunk PRD defines runner-agnostic execution within the Farmslot hierarchy described by [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It is the product contract for the runner-neutral TUI-first model that other chunks should consume rather than re-implement.

## Scope

Runner-Agnostic Execution owns the execution contract shared across Claude, Codex, OpenCode, and future runners:

- TUI-first launch semantics as the default operating mode
- runner capability modeling for prompt delivery, nudging, monitoring, resume, and recovery
- safety tiers and prompt/policy handling
- runner-neutral recovery artifacts and compatibility shims
- the contract that command surfaces and automation layers consume when dealing with different runners

## User Outcome

An operator should be able to supervise different agent runners through one Farmslot execution model without losing visibility, control, or safety semantics when the underlying runner changes.

## Canonical Current State

- Runner-agnostic execution is a declared Farmslot product capability with open roadmap work.
- Existing runner support and tmux-based supervision provide the starting point, but the fully generalized contract is not complete yet.
- Other product chunks already depend on this capability being normalized instead of remaining ad hoc.

## Requirements

### 1. TUI-first by default

Farmslot runners should launch in inspectable, operator-attachable TUI sessions unless a future flow opts into a different mode explicitly.

### 2. Runner-neutral capability model

Prompt handling, progress observation, nudging, resume, recovery, and safety behavior must be expressed in a runner-neutral contract.

### 3. Explicit safety tiers

Dangerous or highly autonomous launch modes need a shared vocabulary and warning model across runners.

### 4. Shared recovery artifacts

Recovery instructions and compatibility shims must be portable enough that future runners can integrate without inventing bespoke operator recovery rules.

### 5. Product-wide consumption

Command Center, automation/orchestration, and core platform layers must consume this model rather than each defining runner behavior independently.

## Boundaries

- This chunk defines the execution contract, not the desktop or mobile UX around it.
- It depends on Core Farmslot for slot/runtime infrastructure.
- It is consumed by automation and control-surface layers, but they do not own its semantics.

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- ADR-023, ADR-024, ADR-025, ADR-027

## Success Condition for This Chunk

Farmslot can add or operate multiple agent runners through one inspectable, recoverable, TUI-first execution contract that the rest of the product understands consistently.
