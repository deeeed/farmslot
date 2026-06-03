---
title: Why Farmslot?
---

# Why Farmslot?

Everyone will have coding agents and model subscriptions. The hard part is turning many agents, project types, and computers into structured engineering capacity that a human can still steer and trust.

Farmslot is built around the idea of scaling the engineer, not replacing the engineer: keep human taste, risk judgment, and final approval, while the system handles repeatable coordination across projects, slots, runners, evidence, and review.

Farmslot is the operating system and IDE around those agents: it remembers intent, dispatches work, shows live execution, lets the operator steer, validates behavior, collects evidence, coordinates review, and turns past runs into future leverage.

## The bottleneck moved

The bottleneck used to be writing code. With coding agents, the bottleneck becomes the loop around code generation:

- deciding what should run next;
- importing the right project context with low friction;
- choosing the right project type, machine, slot, runner, and context;
- watching progress without babysitting terminals;
- proving the changed behavior worked;
- comparing independent review findings;
- keeping useful run history instead of one-off chat transcripts.

Without that loop, adding more agents mostly creates more coordination debt.

## What Farmslot is not

Farmslot is not trying to be the only coding agent, editor, test framework, CI system, or terminal UI.

It can sit above and beside tools like Claude, Codex, Cursor, browser-automation runners, tmux, CI, browsers, devices, and project-specific runners.

The product boundary is the control plane: one operator-visible system for dispatch, supervision, validation, evidence, review, and learning.

## The moat

The defensible part is not any single surface. It is the integrated operating loop:

| Moat layer                  | Why it matters                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Roadmap memory              | Raw ideas and backlog items become structured dispatch candidates instead of disappearing into chat.         |
| Dispatch discipline         | Work starts only when a suitable slot, runner, project context, and risk profile are available.              |
| Isolated execution          | Agents run in predictable slots with project-owned setup, health checks, and resource boundaries.            |
| Project-type framework      | UI apps, CLIs, services, browser extensions, desktop apps, and headless workers share one loop.              |
| Runner-neutral protocol     | UIs, CLIs, mobile clients, and LLM clients operate the same gateway contract.                                |
| Runner capacity leverage    | Multiple model subscriptions and runners become coordinated implementation, review, and validation capacity. |
| Live observability          | Terminals, run state, artifacts, and decisions stay visible while work is happening.                         |
| Deterministic evidence      | Recipes and artifact packages make behavior reviewable instead of relying on agent claims.                   |
| Cross-runner review         | Different models can find different issues and feed one consolidated fix loop.                               |
| Replay and improvement data | Every useful run can improve prompts, templates, recipes, recovery, and future evals.                        |

A single dashboard, recipe, or runner can be copied. The compounding loop is harder to copy because it depends on history, evidence, protocol boundaries, and operator habits working together.

## The human role

Farmslot does not remove the engineer. It moves the engineer to the highest-leverage part of the loop. See [Product vision](./vision.md#operator-role) for the operator boundary.

The goal is one engineer operating like a small, high-trust engineering organization — eventually closer to a team of teams than a single terminal user.
