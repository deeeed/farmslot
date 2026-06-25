---
title: Configurable farm flows
---

# Configurable farm flows

Farmslot scales the operator by turning repeatable engineering coordination into explicit, configurable flows.

The framework should not assume every project starts the same way, validates the same way, or uses the same runner. Instead, the farm describes the stable orchestration shape, and each project supplies the commands and adapters that make that shape real.

## Flow map

```mermaid
flowchart TD
  Sources[Voice, GitHub, Jira, docs, notes]
  Backlog[Farmslot backlog]
  Refine[Human + agent refinement]
  Queue[Dispatch queue]
  Slot[Machine slot]
  Prepare[Prepare + health]
  Prompt[Render worker prompt]
  Runner[Agent runner]
  Observe[Observe + steer]
  Validate[Validation recipe]
  Evidence[Evidence package]
  Review[Cross-runner review]
  Human[Human gate]
  Learn[Replay + improvement]

  Sources --> Backlog --> Refine --> Queue --> Slot --> Prepare --> Prompt --> Runner --> Observe --> Validate --> Evidence --> Review --> Human --> Learn --> Backlog
```

## Project import flow

```mermaid
sequenceDiagram
  participant Op as Operator
  participant Repo as Repository
  participant FS as Farmslot
  participant GW as Gateway
  participant Slot as Slot

  Op->>FS: import project
  FS->>Repo: inspect scripts/docs/tests
  FS->>Op: propose project profile + hooks
  Op->>FS: approve or edit config
  FS->>GW: register project + slots
  GW->>Slot: run health check
  Slot-->>GW: ready / needs setup
```

Current implementations can be manual and explicit. The long-term direction is to make the inspection/proposal step prompt-assisted while keeping operator approval mandatory.

## Dispatch and execution flow

```mermaid
sequenceDiagram
  participant Queue as Dispatch queue
  participant GW as Gateway
  participant Slot as Slot
  participant Runner as Runner
  participant UI as Command Center

  Queue->>GW: ready item
  GW->>GW: match project, slot, safety tier
  GW->>Slot: prepare + health hooks
  GW->>GW: render project-owned worker template
  GW->>Runner: launch with task context
  Runner-->>GW: terminal/status/artifacts
  GW-->>UI: live state + decisions
  UI->>GW: approve, nudge, pause, or recover
```

Configurable points:

- slot selection policy;
- runner/model profile;
- safety tier and human-gate policy;
- prepare and health hooks;
- project-owned prompt template and context bundle;
- completion and recovery rules.

## Prompt observability flow

```mermaid
flowchart LR
  Template[Project worker template]
  Task[Rendered TASK.md]
  Checklist[Markdown checklist]
  Watcher[Progress parser]
  Signal[SIGNAL.json]
  UI[Operator surfaces]

  Template --> Task
  Task --> Checklist --> Watcher --> UI
  Task --> Signal --> UI
```

The template stays project-owned, but the observable shape is shared: markdown headings, checklist items, artifacts under the task directory, and a terminal signal file. See [Customize worker prompts](../guides/customize-worker-prompts.md) for the template format and [Worker signal protocol](../reference/worker-signal-protocol.md) for `SIGNAL.json`.

## Validation and evidence flow

```mermaid
flowchart LR
  AC[Acceptance criteria]
  Recipe[Recipe graph]
  Adapter[Project adapters]
  App[App/runtime]
  Artifacts[Evidence package]
  Review[Review surface]

  AC --> Recipe --> Adapter --> App --> Adapter --> Artifacts --> Review
```

Configurable points:

- recipe graph and action adapters;
- project-native test commands;
- screenshots, videos, logs, traces, and diff capture;
- artifact manifest shape;
- pass/fail policy for human review.

## Steering and recovery flow

```mermaid
sequenceDiagram
  participant Worker as Worker tmux pane
  participant GW as Gateway
  participant UI as Command Center / Mobile
  participant Op as Operator

  Worker-->>GW: terminal output + status
  GW-->>UI: stream state
  Op->>UI: typed or spoken nudge
  UI->>GW: bounded worker action
  GW->>Worker: send input / pause / recover
  Worker-->>GW: new evidence or state
```

Configurable points:

- which worker controls are allowed;
- when a nudge requires confirmation;
- recovery commands;
- terminal capture depth;
- mobile vs desktop authority.

## Configuration boundary

The goal is to make projects portable into Farmslot without hiding their complexity. Project-specific behavior belongs in project-owned config and hooks. Shared orchestration belongs in the gateway, protocol, Command Center, CLI, and Mobile Companion.

That boundary lets Farmslot support very different repositories while keeping the operator experience consistent.
