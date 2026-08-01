---
title: High-level roadmap
---

# High-level roadmap

This is the public roadmap view. It uses the same operating loop as the rest of the docs and avoids repo-local planning detail. Shipped history is intentionally summarized; implementation-level history lives in the repository roadmap, ADRs, and implemented-history docs.

## Current / next / later

| Loop area             | Current                                                                                                                                                              | Next                                                                                                                | Later                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Roadmap + backlog     | Backlog intake, queue handoff, and dispatch concepts are represented in the gateway/product model.                                                                   | Polish backlog refinement, external-source intake, and queue-state UX in Command Center.                            | Human-in-the-loop roadmap ingestion from voice, GitHub, Jira, docs, and notes, centralized into Farmslot for refinement and breakdown. |
| Dispatch + slots      | Pool/project/slot lifecycle, project hooks, slot matching, and isolated execution are active product foundations.                                                    | Harden recovery visibility, dispatch policy tuning, and operator-facing readiness/debug affordances.                | Continuous backlog-to-dispatch operation when slots become available.                                                                  |
| Gateway protocol      | WebSocket frames, method registry, raw `farmslot rpc` CLI access, generated docs, and public API reference pages exist.                                              | Curate the most important gateway methods with stronger examples and tool/client guidance.                          | LLM/tool clients can safely discover and operate capabilities through policy.                                                          |
| Operator surfaces     | Command Center is the desktop supervision surface; Mobile Companion is a shipped companion direction for oversight, evidence, terminals, and workers.                | Continue UI/UX stabilization and public-safe screenshots/mockups; record final sanitized product videos when ready. | Ambient approvals, voice steering, and mobile-first intervention loops.                                                                |
| Validation + evidence | Recipe Protocol v1 is documented as the canonical spec; `@farmslot/protocol`, `@farmslot/recipe-harness`, and `@farmslot/expo-recipe` are published public packages. | Publish/finish the remaining adoption packages and improve reusable recipe graphs, action manifests, and examples.  | Evidence libraries become durable regression and eval assets.                                                                          |
| Review + learning     | Cross-runner review, replay/eval packages, retrospectives, and recursive improvement are core product directions with shipped foundations.                           | Close replay provenance gaps and standardize eval packages for prompt/template/runner/protocol changes.             | Prior runs continuously improve prompts, templates, recipes, and recovery policy.                                                      |

## Near-term focus

1. **Finish public-release readiness**: keep the repo sanitized, preserve docs governance, and publish only from reviewed public-safe assets.
2. **Use static docs-safe mockups until final demos are ready**: the landing page can ship now; final narrated videos should be added after sanitized recording passes.
3. **Keep Recipe Protocol v1 as the public RFC-style spec** and align examples, guides, package READMEs, and validators when protocol behavior changes.
4. **Publish or defer remaining packages deliberately**: `@farmslot/protocol`, `@farmslot/recipe-harness`, and `@farmslot/expo-recipe` are public; `@farmslot/skills`, `@farmslot/cli`, and `@farmslot/theme` should not be claimed as published until they are actually released.
5. **Stabilize operator surfaces** so Command Center and Mobile Companion continue presenting the same gateway truth.
6. **Curate the Gateway API surface** by adding high-value examples before treating generated method tables as the primary public documentation.
7. **Close replay/eval gaps** so reference/candidate packages become a durable regression loop for prompts, templates, runner behavior, harness changes, and protocol changes.

## Strategic direction

Farmslot should become the repeatable supervised engineering loop described in [Operating loop](./concepts/operating-loop.md). That page owns the canonical stage names and sequence.

The long-term value is not only running more agents. It is building a system where raw intent can be refined with the human, external planning data can be centralized into one supervised backlog, and every useful run leaves behind evidence and memory that make the next run safer, cheaper, and easier to review.
