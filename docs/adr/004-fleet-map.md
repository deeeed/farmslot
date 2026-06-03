# ADR-004: Fleet Map Rendering

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [PRD](../PRD-command-center-canonical.md) — Features A1-A5

## Context

The Fleet Map is the spatial overview of all machines and slots. It replaces `farm-status.sh` with a visual canvas. The PRD calls for a "zoomable canvas" — but how zoomable and how canvas-y depends on scale and complexity.

Current fleet: 3 machines, 6-10 slots. Potential growth: 5-8 machines, 15-20 slots.

OpenClaw doesn't have a fleet map equivalent — its UI is conversation-centric, not spatial.

## Options Considered

### A. CSS Grid + CSS `transform: scale()`

Standard CSS layout with manual zoom via `transform: scale()` on a container.

**Pros:**

- Zero library dependencies
- Standard DOM — accessible, searchable, inspectable
- Responsive by default (grid reflows)
- Lit components compose naturally
- Fast at this scale (<50 nodes)

**Cons:**

- No built-in pan/drag
- Zoom via scale() doesn't feel native (no scroll-to-zoom inertia)
- No infinite canvas concept

### B. xyflow (React Flow / Svelte Flow)

Popular node-based canvas library. Built-in zoom, pan, drag, minimap.

**Pros:**

- Production-quality zoom/pan out of the box
- Drag to rearrange
- Minimap widget
- Connection edges between nodes (could show slot relationships)

**Cons:**

- React-based (xyflow) — doesn't integrate with Lit cleanly
- Svelte Flow exists but Lit equivalent doesn't
- Heavy dependency for <20 nodes
- Opinionated layout — fights custom card designs

### C. Pixi.js / Canvas 2D

WebGL/Canvas rendering. True infinite canvas.

**Pros:**

- Unlimited scale (thousands of nodes)
- Buttery smooth zoom/pan
- Full rendering control

**Cons:**

- Custom rendering for everything (no DOM, no CSS, no text reflow)
- Accessibility: none (canvas is opaque to screen readers)
- Massive overengineering for 10 nodes
- Can't embed DOM components (Monaco, xterm) inside canvas

### D. SVG + d3-zoom

SVG elements with d3-zoom for pan/zoom behavior.

**Pros:**

- Native zoom/pan with inertia and constraints
- SVG elements are DOM — accessible, styleable
- d3-zoom is battle-tested
- Can embed foreignObject for HTML content inside SVG

**Cons:**

- foreignObject is quirky across browsers
- SVG layout is manual (no grid/flexbox)
- d3-zoom adds ~30KB
- Mixing SVG and HTML components is awkward in Lit

## Decision

**Option A — CSS Grid** for v1. Revisit if scale exceeds 20 slots.

### Rationale

At 3 machines and 6-10 slots, a CSS Grid with well-designed cards delivers all the value:

- Machine groups as grid rows or columns
- Slot cards as grid items
- Toggle between machine-grouped and project-grouped layouts
- Filter/search for quick slot finding
- Click a card to drill into detail

Adding a canvas library for <15 elements adds complexity without value. If the fleet grows beyond 20 slots, Option D (SVG + d3-zoom) is the natural upgrade path — SVG elements are close enough to HTML that migration is incremental.

### Layout Design

```
┌─────────────────────────────────────────────────────┐
│ Fleet Summary Bar: 8 total | 3 working | 2 ready... │
├──────────┬──────────┬──────────┬───────────────────-─┤
│          │          │          │                      │
│ runner-local  │  runner-a   │  runner-b    │                      │
│ ┌──┐┌──┐│ ┌──┐┌──┐ │ ┌──┐    │                      │
│ │s1││s2││ │s1││s2│ │ │s1│    │                      │
│ └──┘└──┘│ └──┘└──┘ │ └──┘    │                      │
│ ┌──┐┌──┐│          │          │                      │
│ │s3││s4││          │          │                      │
│ └──┘└──┘│          │          │                      │
│          │          │          │                      │
├──────────┴──────────┴──────────┴──────────────────────┤
│ Group by: [Machine ▼] [Project ▼]  Search: [_____]   │
└──────────────────────────────────────────────────────-┘
```

- Machine groups: CSS Grid columns, auto-sized
- Slot cards: CSS Grid inside each group, 2-3 columns
- Responsive: stacks vertically on narrow screens
- No zoom needed at this scale — everything fits on one screen

## Consequences

**Positive:**

- Zero dependencies, minimal code
- Standard CSS — easy to theme, responsive, accessible
- Lit components compose naturally (no framework mismatch)
- Fast to build and iterate

**Negative:**

- No zoom/pan (acceptable at <20 nodes)
- No drag-to-rearrange (acceptable — layout is config-driven)
- Must revisit if fleet grows significantly

## References

- CSS Grid: native browser layout
- d3-zoom (future upgrade): https://d3js.org/d3-zoom
