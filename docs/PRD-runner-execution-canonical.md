# Farmslot — Runner-Agnostic Execution Canonical PRD

This canonical chunk PRD defines runner-agnostic execution within the Farmslot hierarchy described by [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It is the shared execution contract for tmux sessions and opt-in native structured sessions.

## Scope

Runner-Agnostic Execution owns the execution contract shared across Claude, Codex, OpenCode, and future runners:

- TUI-first launch semantics as the default operating mode
- opt-in native structured transports for clients that operate without tmux
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
- Native structured transports are approved under [ADR-057](adr/057-structured-runner-transports.md). Implementation and live validation remain pending; protocol initialization alone does not establish support.
- The first implementation is experimental under one pinned principal. User-owned execution profiles and proven isolation are later rollout gates, not initial multi-tenant guarantees.

## Requirements

### 1. TUI-first by default

Farmslot runners launch in inspectable, operator-attachable TUI sessions by default. A flow may explicitly select a validated native structured transport. Existing sessions keep their transport; loading a saved session does not imply attachment to its running TUI process.

### 2. Runner-neutral capability model

Prompt handling, progress observation, nudging, resume, recovery, and safety behavior must be expressed in a runner-neutral contract.

### 3. Explicit safety tiers

Dangerous or highly autonomous launch modes need a shared vocabulary and warning model across runners.

### 4. Shared recovery artifacts

Recovery instructions and compatibility shims must be portable enough that future runners can integrate without inventing bespoke operator recovery rules.

### 5. Product-wide consumption

Command Center, automation/orchestration, and core platform layers must consume this model rather than each defining runner behavior independently.

### 6. Native structured sessions

Runner adapters own native protocol mechanics and declare supported interactions. Clients consume shared session commands and events for text, tools, approval, questions, interruption, and recovery. Acceptance, turn start, and turn completion are separate facts. Missing structured evidence remains unknown; unsupported operations fail closed.

Each session has one authoritative input owner and a durable identity bound to its execution node, runner, account context, and native session. Commands and approval replies retain correlation IDs. An account switch cannot reuse another account's process, transcript, or pending request.

The execution node supervises the process independently of gateway and client connections. Persisted events support cursor-based replay. Recovery must report uncertainty and must not resend an accepted prompt. Execution-node loss does not promise process survival.

Users install and authenticate the native runner in their own execution context. Farmslot preserves native tools, authentication, and permission controls. Shared deployments require enforced principal and execution isolation under [ADR-051](adr/051-principal-and-credential-model.md). A shared gateway credential is not proof of account isolation. Subscription eligibility and billing need provider-specific evidence; inference success and token estimates cannot establish them. No automatic paid-API fallback is implied.

### 7. Validation and rollout

Prove Codex and Claude through production gateway RPC before releasing client controls. Extend the same live scenarios to remote workers, retained reviewers, Command Center, Companion, Grok, Cursor, and OpenCode. Each runner must pass its declared capabilities, including reconnect and negative ownership checks. Existing tmux acceptance and retained-handoff scenarios remain required. See the phased gates in [ADR-057](adr/057-structured-runner-transports.md#validation-and-rollout).

## Boundaries

- This chunk defines the execution contract, not the desktop or mobile UX around it.
- It depends on Core Farmslot for slot/runtime infrastructure.
- It is consumed by automation and control-surface layers, but they do not own its semantics.
- Replacing native agent loops with PI, importing a complete third-party UI, and taking over arbitrary live TUI sessions are outside the structured-transport rollout.

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- ADR-023, ADR-024, ADR-025, ADR-027, ADR-043
- [ADR-057: Structured runner transports](adr/057-structured-runner-transports.md)

## Success Condition for This Chunk

Farmslot can operate multiple agent runners through one inspectable, recoverable execution contract. Clients can use validated native structured sessions without tmux, while existing tmux workflows retain their behavior.
