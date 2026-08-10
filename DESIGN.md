# Design

## Source of truth

- Status: Draft
- Last refreshed: 2026-08-10
- Primary product surfaces: Command Center operator UI and recipe-derived visual review boards.
- Evidence reviewed: `CLAUDE.md`, `apps/command-center/CLAUDE.md`, `apps/command-center/ui/src/styles/theme-tokens.ts`, `apps/command-center/ui/src/components/app-shell.ts`, `apps/command-center/ui/src/components/dispatch/dispatch-wizard-view-renderer.ts`, `apps/command-center/ui/src/components/shared/whats-new-modal.ts`, `apps/command-center/ui/src/components/recipe-graph/recipe-graph.ts`, `apps/command-center/ui/src/components/work-graph/work-graph-panel.ts`, `packages/protocol/src/contracts/execution-templates.ts`, `packages/protocol/src/contracts/work-graph.ts`, `apps/companion/DESIGN.md`, and `docs/adr/052-recipe-derived-visual-review-boards.md`.

## Brand

- Personality: dense, technical, operator-first, calm under failure.
- Trust signals: visible state, IDs, timestamps, source refs, explicit gates, and validation evidence.
- Avoid: decorative dashboards, hidden automation, ambiguous success states, and manual text entry where project metadata already exists.

## Product goals

- Goals: help Arthur move from roadmap/backlog planning to dispatchable autonomous work; make dependencies, gates, and the exact selected execution template visible before runs start; keep project labels/tags consistent across planning and execution; turn recipe-owned visual evidence into portable, annotatable feedback without project-specific tooling.
- Non-goals: replacing markdown specs/ADRs as authoring source of truth; building Jira-scale project management; hiding raw files from power users.
- Success signals: users can identify what is ready, blocked, running, failed, and what will unlock next without reading JSON.

## Personas and jobs

- Primary personas: Arthur as operator/architect; external coding agents reviewing or editing markdown specs.
- User jobs: capture rough ideas, refine them into roadmap/backlog specs, dispatch dependent work, and monitor graph progress.
- Key contexts of use: local developer machine, dark terminal-adjacent browser, multi-agent execution, interrupted/resumed sessions.

## Information architecture

- Primary navigation: Command Center left nav with dedicated surfaces for runs, backlog, roadmap, and graphs.
- Core routes/screens: work graphs route for dependency visualization; backlog/roadmap routes for item authoring and refinement.
- Content hierarchy: project/status/tags first, then visual graph, then selected node detail and raw references.

## Design principles

- Principle 1: show the dependency shape first, then expose raw refs/details on selection.
- Principle 2: preserve human-editable markdown/spec workflows; UI should visualize and orchestrate, not own every field.
- Principle 3: planning and execution inventories use compact, sortable rows with explicit Flow, Project, State, ID, and activity columns; selection reveals depth in a side panel instead of expanding every row.
- Tradeoffs: dense technical detail is acceptable; visual polish must not obscure IDs, gates, or dispatch state.

## Visual language

- Color: use Command Center tokens from `theme-tokens.ts`; green = unlocked/satisfied, yellow = waiting/running/gated, red = failed/needs attention, muted = skipped/unknown.
- Typography: monospace, compact labels, bold titles for scanability.
- Spacing/layout rhythm: dense 28–40px inventory rows, 8–16px detail-panel rhythm, and two-pane list/detail or graph/detail layouts on wide screens.
- Shape/radius/elevation: rounded cards using existing radii and shadows; SVG graph nodes mirror card styling.
- Motion: minimal hover/focus feedback only.
- Imagery/iconography: no new icon set; use labels, badges, and graph geometry.

## Components

- Existing components to reuse: app shell route patterns, recipe graph SVG patterns, shared theme tokens, planning controls, and `dispatch-config-editor` for every backlog create/edit dispatch surface.
- New/changed components: compact inventory tables on Roadmap, Backlog, and Runs; shared Backlog create/edit metadata fields whose owning project scopes both templates and eligible slots; `work-graph-panel` and `work-graph-layout` for dependency visualization; `execution-template-preview-modal` for exact, read-only dispatch template inspection; a lightweight recipe-derived visual review board for screen hierarchy and normalized point/area feedback.
- Variants and states: empty graph list, project filter, graph status badges, selected node, waiting/gated/running/succeeded/failed/skipped nodes, pending/satisfied/failed/waived edges; execution-template preview loading, content, stale-source error, and closed states; visual-review boards default to one remembered capture platform with an explicit Compare mode that groups platform variants under one surface, and navigation maps start at the top level with independently expandable branches.
- Token/component ownership: Command Center owns UI tokens; protocol owns graph and execution-template data shapes.

## Accessibility

- Target standard: practical WCAG AA for text contrast and keyboard operation.
- Keyboard/focus behavior: graph nodes and side-list nodes must be selectable with keyboard/focus-visible states; execution-template preview buttons have explicit labels and the modal closes with Escape.
- Contrast/readability: dark background with tokenized status colors and text hierarchy.
- Screen-reader semantics: route titles, project filter labels, diagram labels, and node button labels.
- Reduced motion and sensory considerations: avoid required animation.

## Responsive behavior

- Supported breakpoints/devices: desktop-first with single-column fallback below ~1100px.
- Layout adaptations: list/detail and graph/detail splits collapse into stacked panels; dense inventory tables and SVG remain horizontally scrollable when columns cannot safely compress.
- Touch/hover differences: buttons remain tap targets; hover is enhancement only.

## Interaction states

- Loading: app shell hydration should avoid fake data; work graph empty state is explicit.
- Empty: explain that graphs appear after backlog work is linked into a graph.
- Error: gateway errors surface through existing connection/bootstrap UI; template preview errors stay inside the preview modal without changing the dispatch selection.
- Success: satisfied/ready/succeeded nodes and edges use green badges/lines.
- Disabled: not currently used for read-only graph visualization.
- Offline/slow network, if applicable: preserve previous state until reconnect via existing store behavior.

## Content voice

- Tone: direct operator language.
- Terminology: use roadmap, backlog, work graph, node, edge, gate, family, run consistently with ADR-040/041.
- Microcopy rules: prefer action/state labels over prose; expose raw IDs when helpful.

## Implementation constraints

- Framework/styling system: Lit v3 components in `apps/command-center/ui`, CSS in shadow DOM.
- Design-token constraints: import from `ui/src/styles/theme-tokens.ts`; avoid inventing a second theme layer.
- Performance constraints: client-side SVG layout should handle modest DAGs without new dependencies.
- Compatibility constraints: keep gateway/protocol APIs unchanged for UI-only visualization work.
- Visual-review constraints: keep interactive discovery in the device provider, deterministic proof
  in Recipe v1/harness, domain navigation in project harnesses, and rendering independent of
  gateway or project runtime state.
- Test/screenshot expectations: run `yarn --cwd apps/command-center typecheck`, targeted UI model tests, format check, and CDP browser validation for every UI change.

## Open questions

- [ ] Should work graph project filtering share the global filter state used by runs/backlog, or remain route-local? / Arthur / affects cross-screen IA consistency.
- [ ] Should graph nodes deep-link to backlog item specs once backlog route URLs stabilize? / Arthur / affects navigation scope.
