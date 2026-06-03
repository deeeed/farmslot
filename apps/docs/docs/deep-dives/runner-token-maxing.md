---
title: Runners and token-maxing
---

# Runners and token-maxing

Farmslot is runner-neutral by design.

The operator should be able to use different agent runners, model subscriptions, and execution profiles without rebuilding the orchestration system around one vendor or one CLI.

## Runner model

A runner is a tool that can execute agentic work inside a Farmslot slot.

Examples include TUI-first coding agents, command-line coding agents, or future local/cloud runners. Farmslot should normalize the parts the operator cares about:

- launch semantics;
- prompt delivery;
- terminal observation;
- nudging and resume behavior;
- safety tier;
- artifact and recovery output;
- completion detection.

## Token-maxing as capacity strategy

“Token-maxing” is the practice of using available model subscriptions and token budgets as parallel engineering capacity.

The important product idea is not spending for its own sake. It is matching work to the right runner/model/profile:

| Work type                   | Example profile                                        |
| --------------------------- | ------------------------------------------------------ |
| High-ambiguity architecture | strongest reasoning model, slower, more supervision    |
| Mechanical implementation   | cheaper/faster runner once the plan is clear           |
| CI/log triage               | fast deterministic runner with narrow context          |
| Review and critique         | independent runner/model for second opinion            |
| Recipe validation           | deterministic harness first, model only reads evidence |

## Why Farmslot helps

Without a harness, token-maxing becomes chaos: many chats, unclear state, duplicate work, weak validation, and expensive manual review.

With Farmslot, token-maxing becomes supervised capacity:

- queue work into isolated slots;
- choose runner/profile intentionally;
- monitor terminals and decisions centrally;
- validate with recipes and artifacts;
- compare outcomes through eval packages;
- keep human approval at the end.

## Review capacity

Review and critique are part of the capacity strategy, but the canonical cross-runner review workflow lives in [Observability and interoperability](./observability-interoperability.md#consistent-review-across-runners). This page stays focused on runner/profile selection and subscription budget discipline.

## Product boundary

Farmslot should not depend on one model provider. The runner contract should describe capabilities and safety semantics so new runners can plug into the same gateway, Command Center, Mobile Companion, and evidence model.
