---
title: Framework responsibilities
---

# Framework responsibilities

[How Farmslot works](./operating-loop.md) describes the sequence. The division of
responsibility lets different projects use that sequence without copying its
implementation.

| Component                    | Owns                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| Gateway                      | Run state, slot/resource admission, decisions and publication       |
| Project pack                 | Project policy, fixtures, hooks and execution templates             |
| Recipe provider              | Project runtime and action bindings, domain authorization           |
| Recipe engine                | Graph execution, trace, capture lifecycle and claim derivation      |
| Agent runtime                | Task materialization, checklist events and terminal artifact checks |
| Command Center and Companion | Render shared gateway and review models; transport user actions     |
| Worker                       | Code, recipe authoring and task outputs                             |

Pool and slot configuration supplies machine paths, ports and device identity.
Project providers implement their domain behavior and inherit the shared engine,
CLI handlers and artifact validator. Clients render shared facts rather than
recomputing gate eligibility or proof from file presence.

During the current ledger transition, workers may still record manual task
verdicts. The approved single-writer end state assigns normal recipe verdicts to
the engine. See [Recipe evidence loop](./recipe-evidence-loop.md) for that boundary
and [Protocol boundaries](../architecture/protocol-boundaries.md) for the package
contracts.
