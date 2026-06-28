---
title: What is Farmslot?
---

# What is Farmslot?

Farmslot is a local framework for supervised agentic engineering: a way to scale one engineer's judgment across many agent workers, projects, machines, and review loops.

It is the control plane around coding agents, combining current and emerging capabilities for roadmap memory, backlog refinement, dispatch, isolated slots, runner orchestration, live observability, recipe evidence, cross-runner review, and human approval.

> Why the name? I know. It stuck: agentic dev farming across many isolated slots. Naming is harder than scheduling the agents.

## One sentence

Farmslot turns many coding agents and project worktrees into an observable, evidence-backed engineering workflow that a human operator can still control.

## The core problem

AI can generate code faster than teams can verify behavior. The next bottleneck is not typing; it is coordination, memory, validation, and trust.

A diff can look right while the app is still wrong. Farmslot changes the review question from:

> Did the agent say it tested this?

To:

> Can I inspect the exact run, evidence, reviewer findings, and approval gate?

## The operating loop

The canonical loop runs from intent and memory, through backlog refinement, dispatch, isolated execution, observation, validation, review, human approval, and back into improvement data.

See [Operating loop](./concepts/operating-loop.md) for the source-of-truth model. A team can adopt the loop incrementally: recipes and evidence can be useful before the full fleet harness; the full product scales the same trust loop across projects, machines, models, and operators.

A key design goal is low-friction project import. Today that means a small amount of pool/project configuration; over time, Farmslot should provide prompt-assisted import flows that inspect a repository, propose hooks, and make a new project dispatchable with minimal manual setup.

## Reference integrations

Farmslot intentionally keeps project-specific behavior outside core. A project integrates by declaring pool slots, project hooks, fixtures, runner commands, and optional Recipe v1 actions.

Current reference examples:

- **AudioLab** — [github.com/deeeed/audiolab](https://github.com/deeeed/audiolab) is a public Expo/React Native monorepo using Recipe Protocol v1 for app navigation, screenshots, and AudioLab-specific native audio probes. It shows how a real app can keep its existing bridge while emitting standard Farmslot recipe artifacts.
- **Farmslot self-integration** — this repository defines itself as `farmslot-farm` through `projects/farmslot-farm/project.json`, with a local demo slot in `pool/farmslot-demo.json`. Use the same dispatch, typecheck health checks, and recipe/evidence flow as any other integrated project.

## What to read next

- [Why Farmslot?](./concepts/why-farmslot.md)
- [Operating loop](./concepts/operating-loop.md)
- [Product vision](./concepts/vision.md)
- [Gateway control plane](./architecture/gateway.md)
- [Configurable farm flows](./architecture/configurable-flows.md)
- [Import a project](./guides/import-a-project.md)
- [Gateway API capability surface](./reference/gateway-api.md)
- [Adoption path](./guides/adoption-path.md)
