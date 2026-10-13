---
title: Choosing a supervised workflow
---

# Choosing a supervised workflow

Use the [introduction](../intro.md) for the product overview and
[How Farmslot works](./operating-loop.md) for the run sequence. This page explains
which responsibilities move into Farmslot when you adopt it.

| Need                | Farmslot responsibility                                 | Project responsibility                             |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Isolated execution  | Claim and release a configured slot                     | Declare checkout, fixtures and health hooks        |
| Progress            | Track run state, checklist events and terminal signals  | Follow the shared task and `mark` contract         |
| Behavioral evidence | Execute recipes and validate retained packages          | Author claims and assertions against real behavior |
| Review              | Start a separate reviewer session and retain its result | Configure review policy and respond to findings    |
| Publication         | Check prerequisites and publish approved evidence       | Supply the change and publication text             |

A reviewer session can use the same runner as the worker. Choose runner and model
through review policy; COLD/WARM describes reviewer session continuity, not a
requirement to switch vendors.

The operator still chooses intent, priorities and risk policy, reviews visual
claims, and approves publication. [Adoption path](../guides/adoption-path.md)
starts with explicit project configuration before adding more automation.
