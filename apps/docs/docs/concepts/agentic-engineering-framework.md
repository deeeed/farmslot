---
title: Agentic engineering framework
---

# Agentic engineering framework

Farmslot is an **agentic engineering framework and control plane**: the place where one operator can scale work across many project types, machines, devices, model runners, and subscriptions without losing control of quality.

The point is not to replace the engineer with a black box. The point is to give the engineer a stronger framework for supervised agentic work:

- a **control plane** for projects, slots, machines, runners, lifecycle hooks, memory, and policy;
- an **IDE** for watching terminals, steering runs, inspecting artifacts, and making decisions;
- a **framework** that can adapt to mobile apps, web apps, browser extensions, desktop apps, CLIs, services, workers, and headless systems;
- a **proof-first trust layer** where recipes validate behavior visually and mechanically, then turn claims into reproducible evidence.

## Why this matters

A single agent can be useful. Many agents across many repositories can become chaos unless the surrounding system is strong enough.

Farmslot is built for the operator who wants to say:

> I want to run more work in parallel, across more projects, project types, computers, and model subscriptions, but I still need to understand what happened and trust the result.

That requires more than prompts. It requires an operating loop.

## The control-plane layer

The control-plane layer coordinates the environment around agents:

| Control-plane responsibility | What Farmslot provides                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Projects                     | Importable project profiles with hooks, fixtures, health checks, and validation expectations.         |
| Slots                        | Isolated workspaces tied to machines, devices, ports, branches, and runtime state.                    |
| Machines                     | Local and remote computers treated as a fleet instead of one-off terminals.                           |
| Runners                      | Claude, Codex, Cursor, scripts, browser automation, and custom runners behind a common control plane. |
| Lifecycle                    | Prepare, dispatch, monitor, validate, recycle, and recover as explicit phases.                        |
| Memory                       | Runs, artifacts, decisions, retrospectives, and curated learnings that survive a chat session.        |

This is what lets one engineer scale beyond one project, one terminal, one machine, and one model subscription.

## The IDE layer

The IDE layer is the human-facing cockpit for the same system.

It should let the operator:

- see what is running across the fleet;
- open the live terminal and app state;
- understand the current plan;
- approve, redirect, or stop risky actions;
- inspect screenshots, traces, summaries, and diffs;
- compare reviewer feedback;
- decide when the work is ready.

This is why the key phrase is **watch and steer**. The operator is not waiting for a final agent message. The operator is guiding the run while the work is happening.

## The project framework layer

Farmslot should work across many kinds of software because the core loop is project-agnostic:

| Project type                 | Typical capabilities                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Mobile / Expo / React Native | App launch, device control, UI actions, HUD intent, screenshots, traces.          |
| Web apps                     | Browser launch, CDP actions, DOM assertions, screenshots, console/network traces. |
| Browser extensions           | Extension lifecycle, browser automation, background/page inspection, UI proof.    |
| Desktop apps                 | App launch, window automation, screenshots, logs, local process health.           |
| CLIs                         | Command execution, stdout/stderr assertions, file artifacts, exit-code checks.    |
| Backends / services          | Health checks, API calls, logs, traces, contract tests, fixture setup.            |
| Headless workers             | Queue/job setup, log watching, output validation, summary artifacts.              |

Each project owns its hooks and custom capabilities. Farmslot owns the shared operating loop: dispatch, watch, steer, validate, review, and improve.

## Runner capacity leverage

Farmslot also turns scattered model capacity into coordinated engineering throughput.

Instead of using each model subscription or runner as a separate chat window, the operator can assign them roles:

- one runner implements;
- another investigates;
- another writes or executes recipes;
- another reviews the diff and evidence;
- another curates retrospective learnings.

That is how a single operator can start working like a **team of teams**: many agents, many computers, many projects, one control plane, one trust layer.

## The proof-first trust layer

The trust layer is the recipe concept at the core of the framework: validate what the agent did visually when the project has a UI, validate it mechanically when it does not, and package the proof so a human can review it.

Recipes make the system credible because they convert acceptance criteria into deterministic proof:

1. set up the required state;
2. perform real actions;
3. assert the expected behavior;
4. capture screenshots, traces, summaries, and logs;
5. make the result reviewable and repeatable.

Without recipes, an agent can only tell you what it thinks happened. With recipes, the system can show what happened: screenshots, HUD intent, traces, logs, summaries, and assertions tied back to the acceptance criteria.

## The product in one sentence

Farmslot is the framework for scaling supervised agentic engineering: **coordinate many project types and model runners, watch and steer agents like an IDE, and trust results through visual validation, executable recipes, and proof artifacts.**
