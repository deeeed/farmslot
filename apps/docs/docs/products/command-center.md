---
title: Command Center
---

# Command Center

Command Center is the desktop operator surface for Farmslot.

It exists because supervising many agents from one serial chat or a pile of terminal windows does not scale. The operator needs a persistent cockpit for fleet state, run state, evidence, terminals, decisions, and publication gates.

<img class="product-image" src="/img/mockups/command-center.svg" alt="Illustrated Command Center product mockup" />

## Core jobs

<div class="product-grid">
  <div class="product-tile"><strong>Fleet overview</strong><br/>Slot health, readiness, machine state, and dispatchability.</div>
  <div class="product-tile"><strong>Run supervision</strong><br/>Run families, lanes, active work, progress, and status transitions.</div>
  <div class="product-tile"><strong>Terminal streaming</strong><br/>Inspectable worker panes and live output when intervention is needed.</div>
  <div class="product-tile"><strong>Evidence review</strong><br/>Artifacts, screenshots, traces, diffs, validation outputs, and recipe proof.</div>
  <div class="product-tile"><strong>Decision gates</strong><br/>Human approvals before publication, recovery, or high-impact next steps.</div>
  <div class="product-tile"><strong>Eval/replay</strong><br/>Reference/candidate comparisons for prompts, templates, runners, and harness changes.</div>
</div>

## Relationship to the gateway

Command Center is a client of the gateway. It should not invent a second state model.

```mermaid
flowchart LR
  Gateway[Gateway shared state]
  Fleet[Fleet + slots]
  Runs[Runs + families]
  Artifacts[Artifacts + evidence]
  Decisions[Decision queue]
  UI[Command Center]

  Fleet --> Gateway
  Runs --> Gateway
  Artifacts --> Gateway
  Decisions --> Gateway
  Gateway --> UI
  UI --> Gateway
```

## Operator workflow

1. See which slots and workers are available.
2. Dispatch or inspect work from a structured surface.
3. Watch live terminals only when needed.
4. Review evidence, diffs, recipe traces, and before/after artifacts.
5. Approve, reject, recover, or ask for another iteration.

## Demo evidence

The illustration above is a docs-safe product mockup. Public demos should use a clean synthetic dataset:

- fleet overview with non-sensitive slot names;
- run detail with a synthetic artifact package;
- evidence workspace with generic before/after media;
- eval comparison with synthetic reference/candidate packages.
