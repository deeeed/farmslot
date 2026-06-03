---
title: Product vision
---

# Product vision

Farmslot is an agentic engineering OS and IDE for operating, steering, validating, and improving coding-agent work across many project types, machines, and model runners.

The goal is not to hide agents behind a black box. The goal is to make parallel agent work **operator-controlled, observable, reproducible, and reviewable**.

## Product thesis

AI coding agents need more than prompts. They need an operating environment:

- isolated places to work;
- low-friction project import across UI, mobile, web, CLI, service, desktop, and headless projects;
- project-aware setup and health checks;
- a runner-neutral gateway protocol;
- a way to coordinate capacity across multiple model runners and subscriptions;
- desktop and mobile supervision surfaces;
- deterministic validation recipes;
- durable artifacts and evidence;
- explicit human gates before high-impact actions;
- replay/eval loops so the system improves instead of only producing one-off outputs.

Farmslot is that environment: an OS for the fleet, an IDE for the operator, and a proof-first trust layer built around visual validation, executable recipes, and reviewable artifacts.

## Current / next / later

| Stage   | Product focus                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current | Gateway, CLI/protocol, slot lifecycle, project/pool configuration, Command Center operator flows, tmux visibility, recipe/evidence contracts.                     |
| Next    | Stronger Gateway Intelligence, clearer project-import guides, curated public capability docs, cross-runner review as a standard workflow, sanitized public demos. |
| Later   | Human-in-the-loop roadmap ingestion, rough-idea refinement, ambient mobile approvals, and increasingly autonomous backlog-to-dispatch operation.                  |

## Scaling the engineer across projects

Farmslot should make it practical for one operator to bring multiple repositories into the same supervised loop. The near-term path is explicit configuration: define a project, define its slots, and wire the hooks that know how to prepare, validate, recycle, and collect evidence.

The long-term path is prompt-assisted import. A runner should be able to inspect a repository, propose a project profile, suggest health checks and validation flows, and leave the human to approve the configuration instead of hand-authoring everything from scratch.

## Roadmap refinement direction

A long-term goal is to make roadmap and backlog refinement a first-class loop, not just a source list. Farmslot may ingest data from tools such as GitHub, Jira, docs, or voice notes, but the operator should be able to centralize that intent inside Farmslot, refine it with the system, and decide what becomes dispatchable agent work.

This design is intentionally still rough. The stable vision is human-in-the-loop refinement: raw ideas become scoped backlog items, backlog items become dispatch candidates, and dispatch candidates carry acceptance criteria, risk, runner fit, and expected evidence.

## Operator role

Farmslot moves the human out of repetitive coordination, not out of judgment.

The operator remains responsible for:

- intent and prioritization;
- architecture and product taste;
- security and risk judgment;
- visual and code review;
- final approval.

The system handles the repeatable work around that judgment: dispatch, isolation, monitoring, validation, evidence collection, reviewer coordination, and learning.

## Product surfaces and capabilities

Each public-facing surface or capability serves the same operating loop:

| Surface or capability      | Role                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Gateway                    | Typed control plane for state, methods, events, auth, capabilities, and project/slot configuration.                   |
| Command Center             | Desktop mission control for fleet, runs, terminals, artifacts, and decisions.                                         |
| Mobile Companion           | Ambient oversight and intervention when the operator is away from the desktop.                                        |
| Backlog and dispatch queue | Centralizes raw intent from humans or external systems, then refines it into policy-checked work for available slots. |
| Gateway Intelligence       | Evidence-backed automation for scoring, monitoring, recovery, summaries, and evals.                                   |
| Recipe evidence            | Deterministic proof layer and reusable regression assets.                                                             |
| CLI and protocol           | Scriptable and runner-neutral access to the same gateway contract.                                                    |
