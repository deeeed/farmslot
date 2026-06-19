# Mobile Companion Design

## Source of truth

- Status: Draft for evidence-first UX simplification
- Last refreshed: 2026-06-19
- Primary product surfaces: Mobile Companion review flow, evidence viewer, PR/diff context, worker terminal control.
- Evidence reviewed: `docs/PRD-mobile-companion-canonical.md`, `docs/ROADMAP-next.md`, current Expo Router routes under `src/app`, run/evidence/diff/terminal feature modules, and existing screenshot/recipe harnesses.

## Brand

- Personality: calm operator cockpit, not desktop parity on a phone.
- Trust signals: current connection/profile, run status, PR/review state, evidence completeness, terminal target.
- Avoid: dashboard density, duplicate desktop navigation, raw JSON-first controls, and filters/chrome that compete with evidence.

## Product goals

- Goals:
  - Make visual evidence and before→after deltas the default mobile experience.
  - Let an operator move from evidence → diff → terminal/worker nudge in one or two taps.
  - Keep Command Center parity available only behind Advanced/More surfaces.
- Non-goals:
  - Recreate the full Command Center dashboard hierarchy.
  - Expose every fleet/slot/run metric by default.
  - Make mobile the primary authoring surface for large tasks.
- Success signals:
  - A PR/run can be judged from the phone without hunting through tabs.
  - Before/after screenshots and videos are visible before pipeline internals.
  - Worker terminal access is contextual to the run/PR being reviewed.

## Personas and jobs

- Primary persona: operator away from desktop, validating whether a worker's change is acceptable.
- User jobs:
  - Review visual evidence and videos.
  - Compare before→after and inspect code diff context.
  - Open the related PR/family/retro package.
  - Connect to the relevant worker terminal/tmux pane to steer or recover.
- Key contexts of use: one-handed phone use, intermittent attention, remote network via Tailscale/LAN, small-screen review during active PR work.

## Information architecture

- Primary navigation:
  - Review: default evidence/decision queue across active runs, PRs, family retros, and ready/review gates.
  - Terminals: all worker/tmux access, with recently-related workers first.
  - Settings: pairing, profiles, environment, diagnostics.
  - Advanced/More: raw Runs, Fleet, PR dashboard, Inbox, Co-Pilot, filters, and low-level debug views.
- Core review package tabs:
  - Evidence: before→after visual pairs and videos first.
  - Diff: changed files and visual/code context.
  - Timeline: compact status/progress; pipeline details collapsed.
  - Terminal: linked worker/tmux control.
  - Files: full artifact list and raw supporting data.
- Content hierarchy: signal summary → primary evidence → next action → supporting detail.

## Design principles

- Evidence first: visual proof beats metrics unless the run is failing.
- Contextual steering: every run/PR/family screen should answer “which worker do I talk to?”
- Progressive disclosure: raw fleet, filters, JSON, retry internals, and diagnostics are Advanced.
- One review package model: run detail, PR evidence, family retros, and decision workspaces should feel like the same tabbed review object.
- Preserve escape hatches: power-user surfaces remain reachable but should not dominate first launch.

## Visual language

- Color: keep existing dark theme and status colors; reserve accent for primary review action.
- Typography: larger evidence titles and short status summaries; reduce small metadata rows on default screens.
- Spacing/layout rhythm: fewer cards per screen, larger media rails, sticky action bar on review package screens.
- Shape/radius/elevation: reuse existing card/radius tokens.
- Motion: horizontal swipe for evidence pairs; avoid heavy animated chrome.
- Imagery/iconography: use thumbnails/videos as primary imagery; icons only as secondary labels.

## Components

- Existing components to reuse:
  - `EvidenceReviewWorkspace`, `BeforeAfterPreview`, `MobileDiffViewer`, `XtermTerminalView`, `RunWorkspaceNav`.
- New/changed components:
  - Review package segmented tabs shared by run/family/PR/decision workspaces.
  - Evidence-first review card for queue rows.
  - Sticky Review Actions bar (`Open diff`, `Terminal`, `Approve/Follow up` where available).
  - Advanced drawer/list for parity surfaces.
- Variants and states:
  - No evidence, visual-only, diff-only, failed run, terminal unavailable, stale worker, offline gateway.
- Token/component ownership: app-local theme tokens in `src/lib/theme.ts`; avoid a new design system layer.

## Accessibility

- Target standard: touch-friendly, readable, high contrast; WCAG AA where feasible.
- Keyboard/focus behavior: terminal controls must stay reachable and not trap focus.
- Contrast/readability: default cards should avoid muted-on-muted metadata overload.
- Screen-reader semantics: evidence cards need labels identifying before/after/video and run/PR context.
- Reduced motion: swipe rails should not be required for access; list alternatives stay available.

## Responsive behavior

- Supported devices: phone first; tablet can use wider split review package layouts later.
- Layout adaptations: phone shows one primary tab at a time; tablet may show evidence + diff side by side.
- Touch/hover differences: all primary actions must be thumb-reachable.

## Interaction states

- Loading: skeleton/compact status plus last-known run summary when available.
- Empty: explain what to scan or connect; avoid blank dashboard pages.
- Error: show gateway/profile/retry action, not stack traces.
- Success: show evidence completeness and next action.
- Disabled: explain unavailable terminal/evidence/diff requirements.
- Offline/slow network: keep cached profile and show reconnect/pairing route.

## Content voice

- Tone: direct operator language.
- Terminology: “Review package”, “Evidence”, “Diff”, “Terminal”, “Advanced”.
- Microcopy rules: one-line intent; avoid protocol nouns unless in diagnostics.

## Implementation constraints

- Framework/styling system: Expo Router + React Native StyleSheet + existing theme.
- Design-token constraints: use `src/lib/theme.ts`; do not introduce Tailwind or a separate UI kit.
- Performance constraints: media thumbnails/video must not stall route transitions; lazy-load files tab.
- Compatibility constraints: keep existing deep links and gateway protocol; no protocol additions for the first simplification slice unless evidence proves a gap.
- Test/screenshot expectations: every feature slice should include before/after screenshot recipe artifacts for changed screens.

## Open questions

- [ ] Should the default bottom tab count be three (`Review`, `Terminals`, `Settings`) or four with `Advanced` visible?
- [ ] Which operator action is allowed from mobile for ready/review gates: approve only, follow-up dispatch, or comment/nudge first?
- [ ] Should PR diff be embedded in the review package or opened as a dedicated fullscreen diff route by default?
- [ ] What is the minimum useful terminal control set for one-handed steering?
