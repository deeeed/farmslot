# Farmslot — Mobile Companion UI Architecture Refactor

**Status:** Approved (plan only — no implementation yet)
**Date:** 2026-06-08
**Owner:** Arthur / Farmslot
**Relates to:** [PRD-mobile-companion-canonical.md](../PRD-mobile-companion-canonical.md), [ROADMAP-next.md](../ROADMAP-next.md) immediate execution order item 1 (operator UI/UX stabilization pass), [ADR-033](../adr/033-mobile-tmux-worker-control.md)

## Scope

Restructure the Mobile Companion so route files stay thin, business/data orchestration lives in feature-level screen controllers, and presentational UI is split into maintainable components with co-located styles. This is **structural stabilization** of shipped operator surfaces — not a new product lane and not desktop parity work.

**Delivery model:** workspace refactor ships as one PR (slot + family + workspace-scoped CI gate); terminal/artifacts/run/decision/diff + full-tree strict gate follow in a second PR.

In scope:

- Feature-folder layout under `apps/companion/src/features/`
- Screen controller hooks (one hook call per route; controllers own fetch/subscribe/refresh)
- Shared workspace UI kit for slot/family/decision workspace overlap
- `apps/companion/AGENTS.md` as the agent contract for future changes
- Companion file-size and boundary quality gates
- Recipe smoke coverage on touched navigation flows before each merge

Out of scope:

- New gateway methods or protocol changes
- Rewriting `src/lib/` domain modules (keep and consume them)
- Visual redesign / pixel polish before structure lands
- TanStack Query or new global state libraries (revisit only if controllers stay messy after PR 1)
- Background wake-word, auto-send voice, remote node provisioning (deferred mobile scope per ADR-033)

## User Outcome

An operator or agent opening a companion screen can understand its structure in minutes: route → controller → screen layout → components. Workspace screens (slot, family, decision, artifacts) stop duplicating cockpit/evidence/gate UI. Future agent edits touch one feature folder instead of a 5k-line route file, reducing regression risk during the stabilization pass.

## Canonical Current State

- `apps/companion/src/lib/` is strong: pure domain helpers with unit tests (`slot-workspace`, `workspace-navigation`, `decision-presentation`, `artifact-url`, etc.).
- `apps/companion/src/store/` holds thin global session state (fleet, decisions, connection, filters).
- Tab/list screens (`inbox`, `fleet`, `prs`) are reasonably sized and store-driven.
- Heavy workspace routes absorbed presentation + orchestration inline:
  - `app/slot/[id].tsx` ~5.2k LOC, 10+ `useEffect`s, 20+ inline subcomponents
  - `app/family/[familyId].tsx` ~5.6k LOC, 11 `useEffect`s, duplicated cockpit/evidence panels
  - `app/terminal/[slotId].tsx` ~3.7k LOC, 17 `useEffect`s
- Command Center already proved the breakup pattern via slot-view decomposition (`apps/command-center/CODE_QUALITY.md`).

## Target Architecture

### Layer boundaries

| Layer                                        | Owns                                                           | Must not own                     |
| -------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `src/lib/`                                   | Pure transforms, protocol narrowing, URL builders              | React hooks, gateway client, JSX |
| `src/store/`                                 | Cross-screen session caches (fleet, decisions, connection)     | Screen-specific view models      |
| `src/features/<feature>/use-*-controller.ts` | Fetch, subscribe, refresh, loading/error, request cancellation | JSX, `StyleSheet`                |
| `src/features/<feature>/*Screen.tsx`         | Section layout, scroll/sticky chrome                           | `client.request`, business rules |
| `src/features/<feature>/components/`         | Presentational UI                                              | Direct gateway calls             |
| `src/app/*.tsx`                              | Parse route params, call controller, render screen shell       | Effects, styles, domain logic    |

### Screen controller contract

Every heavy route follows:

```tsx
export default function ExampleRoute() {
  const params = useExampleRouteParams();
  const screen = useExampleController(params);

  if (screen.status === 'loading') return <WorkspaceLoading />;
  if (screen.status === 'error')
    return <WorkspaceError error={screen.error} onRetry={screen.actions.refresh} />;

  return (
    <ExampleScreen viewModel={screen.viewModel} actions={screen.actions} chrome={screen.chrome} />
  );
}
```

Rules:

- **Zero** `useEffect` in `src/app/` route files (except root `_layout.tsx` bootstrap).
- **Zero** `client.request` or `client.subscribe` in route files or presentational components.
- Controllers return `{ status, viewModel, actions, chrome? }` — UI never assembles raw protocol payloads inline.
- Controllers may use multiple internal effects initially; consolidate later if needed. Routes still see only one hook.

### Folder layout (target)

```
apps/companion/src/
  app/                          # Expo routes only
  features/
    workspace-shared/           # slot + family + decision overlap
      components/
      hooks/
      styles/
      workspace-shared-model.ts
    slot-workspace/
    family-workspace/
    run-detail/
    terminal/
    artifacts/
    decision-workspace/
  components/                   # app-wide primitives
  lib/                          # unchanged
  store/                        # unchanged
```

### Shared workspace kit (extract once)

- `CockpitTile`, `WorkspaceMetric`, `WorkspaceAction`
- `BeforeAfterPriorityPanel` (merge slot + family variants)
- `FocusedArtifactCard`, `DecisionSignalsPanel`
- `useWorkspaceRouteParams`, `useWorkspaceStickyNav`
- `workspace.styles.ts`

## Requirements

### 1. Mechanical refactor only

No intentional UX or navigation behavior changes. No "while we're here" fixes mixed into extraction commits. If a refactor exposes a bug, fix in the same PR only when required for parity; otherwise file a follow-up.

### 2. Reuse existing domain layer

Controllers call `src/lib/*` selectors and formatters. Do not duplicate `slot-workspace`, `workspace-navigation`, or `decision-presentation` logic inside components.

### 3. Request safety

Controllers use request-id or abort semantics for overlapping refreshes (promote existing `*RequestRef` patterns from slot screen).

### 4. Agent contract

`apps/companion/AGENTS.md` is mandatory reading for companion edits. New screens must follow the controller pattern before merge.

### 5. Size gates

- **Workspace PR:** blocking CI gate scoped to migrated slot/family paths (`yarn quality:structure:ci`)
- **Follow-up PR:** extend strict scope to terminal/artifacts/run/decision routes; tighten panel limits after further splits

Thresholds:

- `src/app/**/*.tsx` > 200 LOC
- `src/features/**/components/*.tsx` > 500 LOC (panels ratchet tighter after split)
- `src/features/**/use-*-controller.ts` > 500 LOC

### 6. Freeze companion feature work

No parallel companion feature PRs until PR 1 merges. Reduces rebase pain on ~11k LOC workspace moves.

## Execution

### PR 1 — Workspaces (single refactor PR)

**Goal:** Land the pattern and kill the two largest god screens in one mechanical pass.

**Branch suggestion:** `refactor/companion-workspaces`

**Commit order inside the PR** (single PR, logical commits):

1. `features/workspace-shared/` — hooks (`useWorkspaceRouteParams`, `useWorkspaceStickyNav`), shared components, styles
2. `features/slot-workspace/` — controller, model, screen, components, styles; thin `app/slot/[id].tsx`
3. `features/family-workspace/` — same; thin `app/family/[familyId].tsx`
4. `scripts/quality/check-companion-structure.mjs` (or companion script) — **warn-only**
5. Delete duplicated helpers (`routeParamString`, `shortId`, cockpit tiles) from old route locations

**Deliverables:**

| Item                                 | Target                                                           |
| ------------------------------------ | ---------------------------------------------------------------- |
| `app/slot/[id].tsx`                  | < 100 LOC, no effects/gateway/styles                             |
| `app/family/[familyId].tsx`          | < 100 LOC, no effects/gateway/styles                             |
| `use-slot-workspace-controller.ts`   | owns all slot fetch/subscribe                                    |
| `use-family-workspace-controller.ts` | owns all family fetch/subscribe                                  |
| Controller unit tests                | mocked `GatewayClient` for both (follow-up if not in first pass) |
| `AGENTS.md`                          | already present; update if PR 1 reveals gaps                     |

**Acceptance checklist:**

- [ ] Slot and family routes are thin shells only
- [ ] No duplicated cockpit/evidence UI between slot and family (shared kit used)
- [ ] `yarn --cwd apps/companion typecheck` passes
- [ ] `yarn --cwd apps/companion test:lib` passes
- [ ] `yarn --cwd apps/companion quality:structure:ci` passes (workspace-scoped blocking gate)
- [ ] Controller tests: loading, error, refresh, workspace run selection (slot); family sections load (family)
- [ ] Recipe smoke: slot ready/review workspace, before→after evidence, history compare, task progress
- [ ] Recipe smoke: family runs, evidence groups, retrospectives, change ledger
- [ ] Manual operator pass on one real slot + one family (if available)
- [ ] Independent `/review` before merge (repo hard rule)

**Estimated touch surface:** ~11k LOC reorganized (mostly moves), not new product logic.

---

### PR 2 — Remaining screens + hardening

**Goal:** Apply the same pattern to terminal/artifacts/run/decision/diff; enforce structure in CI.

**Branch suggestion:** `refactor/companion-remaining`

**Priority order inside the PR:**

1. `features/terminal/` — `terminal/[slotId].tsx`, `terminal/worker.tsx`
2. `features/artifacts/` — `artifacts/[runId].tsx`
3. `features/run-detail/` — `run/[id].tsx`
4. `features/decision-workspace/` — `decision/[id].tsx`
5. `features/diff/` — `diff/[runId].tsx`, `diff/slot/[slotId].tsx`
6. `(tabs)/settings.tsx` only if still > 150 LOC after above (optional in PR 2)
7. Extend file-size gate to **all** `app/` routes and panel files (workspace scope already blocking in CI); shared `GatewayClient` test fixture if useful

**Acceptance checklist:**

- [ ] All listed routes < 150 LOC
- [ ] No `client.request` in `src/app/` except `_layout.tsx` bootstrap
- [ ] CI fails on new oversize route files
- [ ] Controller tests or recipe smoke for each feature's primary operator path
- [ ] Terminal: PTY/streaming, shortcut keys, reconnect — manual or recipe validation
- [ ] Workers list → worker terminal recipe smoke
- [ ] Gateway reconnect mid-screen refreshes controller state
- [ ] Independent `/review` before merge

---

## Verification Matrix

| Flow                            | PR  | Recipe / test                                 |
| ------------------------------- | --- | --------------------------------------------- |
| Slot ready/review workspace     | 1   | Expo recipe navigation smoke                  |
| Slot before→after evidence      | 1   | Recipe + visual pair open                     |
| Family evidence groups          | 1   | Recipe section navigation                     |
| Decision inbox → workspace      | 2   | Recipe inbox → decision → workspace           |
| Terminal attach + shortcut keys | 2   | Manual + recipe if harness supports PTY       |
| Workers list → worker terminal  | 2   | Recipe workers flow                           |
| Gateway reconnect mid-screen    | 1–2 | Controller refresh on connection store change |
| Run detail / artifacts / diff   | 2   | Recipe smoke per screen                       |

## Risks and Mitigations

| Risk                            | Mitigation                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| PR 1 too large to review        | Mechanical-only commits; `/review` required; recipe gate before merge                   |
| Behavior drift during move      | No semantic changes; operator spot-check on PR 1                                        |
| Controller becomes new god file | Compose sub-hooks (`use-slot-history`, `use-slot-task-progress`) inside main controller |
| WS subscription leaks           | `useEffect` cleanup in controllers; unmount test                                        |
| Parallel companion edits        | Freeze until PR 1 lands                                                                 |
| Terminal regressions            | Keep terminal out of PR 1; dedicated validation in PR 2                                 |
| Scope creep                     | Explicit non-goals; polish filed separately                                             |

## What we are not doing

- **One mega-PR for everything** — terminal + workspaces together is too hard to bisect and validate
- **10+ small PRs** — replaced by this 2-PR model per operator preference
- **Workspace-only stop** — PR 1 alone leaves terminal/artifacts as god files; PR 2 required for "production ready"

## Success Condition

After PR 2: no companion route file over 150 LOC; workspace and terminal logic live under `features/`; AGENTS.md + CI gates prevent regression to god-screen pattern; a new agent can edit slot workspace without opening a multi-thousand-line route file.

## Promotion / Lifecycle

- **Keep** until PR 2 acceptance checklist is complete.
- **Promote** durable conventions into `PRD-mobile-companion-canonical.md` supporting evidence after PR 2.
- **Delete** this plan after PR 2 ships and `IMPLEMENTED-HISTORY.md` captures the outcome.
