# ADR-050: Dual-Mode CLI Architecture and Ink TUI Stack

**Status:** Accepted
**Date:** 2026-07-13

## Context

The operator CLI became dual-mode in Phases 0–2 of the CLI overhaul
(`.backlog/specs/farmslot-farm/2026-07-09-cli-tui-protocol-capability.md`):
machine mode emits one stable JSON envelope per invocation
(`docs/reference/cli-machine-envelope.md`), human mode prints formatted text.
Phase 3 adds the interactive layer: a terminal UI covering the operator loop
(fleet, backlog/dispatch, runs/gates, prepare progress) without the web
Command Center.

Two architectural decisions need recording: how the three renderers share one
command core, and which terminal UI stack to build on.

## Decision

### One command core, three renderers

- **Business logic lives in gateway RPC calls plus pure view-model functions**
  (`packages/cli/src/tui/view-models.ts`). View-models map protocol results
  (`FleetStatus`, `BacklogItem[]`, `Run[]`) to render props and are shared by
  the JSON envelope path, the plain-text formatters, and the TUI.
- **The TUI never forks business rules.** Anything the TUI can do (dispatch,
  close-shipped, gate resolution) calls the same RPC methods as the typed
  subcommands; honesty rules (stale banners, ghost-slot suppression) come from
  the gateway-annotated fleet, not from renderer-side logic.
- **Long-lived connection:** the TUI holds one authenticated WebSocket and
  consumes `fleet.updated` / `backlog.updated` / `run.updated` broadcast events
  for live refresh (`GatewayClient.connect()`), while one-shot commands keep
  their per-invocation sockets.

### Stack: Ink (React for terminals)

Chosen: **Ink + React current majors**, colocated under `packages/cli/src/tui/`.
Shipped on Ink 5 + React 18 (2026-07-13), upgraded to Ink 7 + React 19 the same
week (React 19 types drop the global `JSX` namespace — import `type { JSX }`
from `react`). Guided wizards use **@clack/prompts** as anticipated below.

- Ink is the de-facto standard for interactive Node CLIs, renders to any TTY,
  and its component model matches the existing Lit-based Command Center
  conventions (small view components + shared view-models).
- Alternatives considered: blessed/neo-blessed (unmaintained, imperative),
  @clack/prompts (great for wizards, not for live dashboards; may still be
  used inside flows later), raw ANSI (the status quo — the incident showed it
  does not scale to interactive recovery).
- `react` + `ink` are runtime dependencies of `@farmslot/cli` only; nothing
  else in the workspace gains a React dependency. The TUI mounts only for
  `farmslot tui` (and future TTY pickers) — plain commands never import it,
  keeping startup cost for scripted use unchanged.

## Consequences

- `farmslot tui` is the primary human surface for fleet/backlog/runs; the
  plain formatters remain for one-shot commands and non-TTY output.
- Testing: view-models are pure and unit-tested; surfaces get render tests via
  `ink-testing-library`; live validation drives the TUI against the dev
  gateway in tmux and asserts on captured panes.
- Machine mode is unaffected: `--json`/non-TTY invocations bypass the TUI
  entirely (ADR-referenced envelope contract unchanged).
