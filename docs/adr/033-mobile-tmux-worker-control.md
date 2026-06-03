# ADR-033: Mobile Control of General Tmux Workers

**Status:** Accepted
**Owner:** Arthur / Farmslot
**Last updated:** 2026-05-22
**Stale by:** 2026-08-22
**Relates to:** [ADR-002](002-tmux-streaming.md), [ADR-008](008-remote-communication.md), [ADR-023](023-runner-agnostic-tui-execution.md), [ADR-027](027-unified-gateway-state.md), [ADR-032](032-runner-observability-via-hooks.md), [PRD-mobile-companion-canonical.md](../PRD-mobile-companion-canonical.md)

## Purpose of this file

Architectural decision record for extending existing slot-scoped tmux/terminal surfaces into a registered-node tmux worker control plane for Mobile Companion. Accepted after the 2026-05-22 V1 implementation/validation pass; remaining work is UX polish and deferred hands-free/provisioning scope, not protocol readiness.

## Context

Farmslot has progressively expanded from slot/run orchestration into an operator system for supervising many concurrent development workers. A growing share of useful work now happens in tmux panes that are not cleanly represented as Farmslot runs:

- independent `omx` and `omc` sessions;
- ad hoc Claude/Codex/Cursor sessions;
- plain shell panes;
- worker panes created outside a Farmslot recipe lane;
- panes that may later correlate to a run, PR, slot, or family but do not start there.

Mobile Companion currently focuses on Farmslot-aware supervision: runs, slots, artifacts, gates, PR attention, and terminal surfaces tied to run/slot context. That leaves an operational gap: when the operator is away from the desk, the most useful active worker may be just a tmux pane on a registered node.

The codebase already has public terminal and tmux methods, but they are slot-scoped through `SlotAgentTargetParams`. The node daemon also has private `tmux.capture`, `tmux.send`, and `tmux.list`, but that private `tmux.list` only returns session names. This ADR therefore decides how to reuse the existing surfaces without inventing a separate terminal stack.

## D-033-01: Reuse existing terminal/tmux surfaces, but add worker-ref targeting

**Decision.** Keep the existing public `terminal.*` event/input model and current public `tmux.*` controls as the compatibility base. Add the minimum worker-ref targeting/inventory needed for node/tmux panes instead of building a second terminal transport.

**Alternatives considered.**

- Build a new mobile-only terminal API. Rejected because it duplicates `terminal.data`, PTY/poll fallback, and existing shortcut/input code.
- Force every tmux pane into a synthetic slot. Rejected because independent `omx`/`omc` panes should remain run/slot agnostic.
- Reuse existing slot params unchanged. Rejected because `slotId` is required today and does not identify arbitrary registered-node panes.

**Reasoning.** The existing terminal stack already handles subscribe/input/resize/snapshot and Companion already uses it. The missing seam is target identity, not terminal mechanics.

**Revisit trigger.** Revisit if worker-ref support requires invasive changes that break slot terminal compatibility, or if node-level streaming cannot fit the existing `terminal.data` event model.

## D-033-02: Worker identity is nodeId + tmux target

**Decision.** A general tmux worker is identified by registered `nodeId` plus an explicit tmux target/session-window-pane reference. Slot/run/family ids are optional correlation fields, not identity.

**Alternatives considered.**

- Identify by slot id. Rejected because many desired panes have no slot.
- Identify by process id. Rejected because tmux target is the stable control address; processes change inside panes.
- Identify by pane title/name only. Rejected because titles are not unique or stable.

**Reasoning.** Node plus tmux target matches how tmux control actually works and preserves run-agnostic panes.

**Revisit trigger.** Revisit if tmux target strings prove unstable across reconnects and a stronger pane id/session/window/index tuple is required in persisted UI state.

## D-033-03: All registered-node panes are visible

**Decision.** V1 inventory includes every tmux pane on registered nodes, including plain shell panes and panes with no hooks, tasks, slots, runs, or PRs.

**Alternatives considered.**

- Only show hook-enabled workers. Rejected because hooks are enrichment, not an inclusion condition.
- Only show known agent CLIs. Rejected because plain shell panes are still useful operator targets.
- Only show Farmslot slots. Rejected because the feature exists to cover non-run workers.

**Reasoning.** The product need is operational control over what is actually running in tmux, not only what Farmslot already understands semantically.

**Revisit trigger.** Revisit if all-pane inventory is too noisy after real use; mitigation should start with grouping/filtering, not hiding panes by default.

## D-033-04: Hooks are authoritative enrichment, not inclusion gates

**Decision.** Hook/statusline events are the highest-confidence source for semantic worker scope/status when fresh. Missing or stale hooks degrade to lower-confidence signals but never hide or disable a pane.

Signal precedence:

1. fresh hook-emitted worker scope/status;
2. runner statusline / observability files;
3. worker task/progress files;
4. tmux pane/process state;
5. gateway enrichment from cwd/git/node/run/slot correlation;
6. inferred summaries, labeled as inference.

**Alternatives considered.**

- Trust pane scraping equally with hooks. Rejected because hooks are structural runner truth and pane text is presentation.
- Hide panes without semantic status. Rejected by D-033-03.
- Let inferred summaries overwrite stale hooks silently. Rejected because source/freshness must be visible.

**Reasoning.** ADR-032 fixes runner-state accuracy, but mobile still needs operational visibility for non-hook panes. Signal fusion preserves both.

**Revisit trigger.** Revisit if ADR-032 changes the observability file contract or if real hook data is too sparse to support meaningful mobile status.

## D-033-05: Mobile terminal control is privileged and immediate

**Decision.** For authenticated advanced users, mobile terminal controls send immediately. This includes arbitrary input and shortcut/control keys such as arrows, Escape, Tab, Shift+Tab, `Ctrl+C`, and `Ctrl+D`. V1 should not add confirmation modals around destructive terminal keys.

**Alternatives considered.**

- Confirm `Ctrl+C`, `Ctrl+D`, kill/restart, or large paste. Rejected because the product is an advanced-user terminal and speed matters.
- Remove dangerous controls. Rejected because those controls are a primary reason to use a mobile terminal UI.
- Make controls read-only by default. Rejected because V1 must support active intervention/nudging.

**Reasoning.** The safety boundary is authenticated gateway access and registered-node trust. Adding per-action confirmations would make the mobile terminal worse at its core job.

**Revisit trigger.** Revisit if accidental destructive actions become a repeated real-world issue. Prefer better layout/haptics/logging before modal confirmation.

## D-033-06: Voice is foreground and explicit in V1

**Decision.** V1 voice support is foreground only: record/dictate, review/edit/format, and explicitly tap send. No background wake-word and no automatic send without tap.

**Alternatives considered.**

- Background wake-word. Deferred because it adds OS permission, battery, privacy, and accidental-send complexity.
- Fully hands-free auto-send. Deferred because transcription quality and accidental instructions need later product validation.
- No voice in V1. Rejected because voice dictation is part of the confirmed useful loop for mobile worker nudging.

**Reasoning.** Foreground voice gives the main mobile benefit without adding background automation risk to the first implementation.

**Revisit trigger.** Revisit after foreground voice nudges are used enough to prove which hands-free behaviors are safe and valuable.

## D-033-07: Registered nodes and existing gateway auth are the V1 trust boundary

**Decision.** V1 only manages tmux panes on nodes already registered with the gateway/fleet model and already protected by gateway authentication. It does not add remote node provisioning, enrollment, DNS, TLS, or new auth semantics.

**Alternatives considered.**

- Add remote provisioning/enrollment. Rejected as separate product scope.
- Add a separate mobile auth model. Rejected because the existing gateway auth boundary should protect the protocol consistently.
- Limit to local-network nodes only. Rejected as a product constraint; remote reachability can be configured outside this feature as long as gateway auth applies.

**Reasoning.** Full terminal control is sensitive; the first implementation should not combine it with new exposure/provisioning mechanisms.

**Revisit trigger.** Revisit if deployment requires exposing this feature beyond the existing authenticated gateway, or if node registration semantics change.

## Protocol sketch

Exact type names may change during implementation, but the model must preserve these decisions.

```typescript
interface TmuxWorkerRef {
  nodeId: string;
  session: string;
  window?: string;
  pane?: string;
  target: string;
}

interface TmuxWorkerSummary {
  ref: TmuxWorkerRef;
  title?: string;
  cwd?: string;
  command?: string;
  pid?: number;
  lastActivityAt?: number;
  linkedSlotId?: string;
  linkedRunId?: string;
  linkedFamilyId?: string;
  status: WorkerStatusReading;
}

interface WorkerStatusReading {
  label: string;
  source: 'hook' | 'statusline' | 'task-file' | 'tmux' | 'gateway' | 'inferred' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  observedAt?: number;
  stale?: boolean;
  conflicts?: string[];
}
```

Required operations:

- list worker panes across registered nodes;
- capture current pane content;
- stream live pane output;
- send arbitrary text;
- send named shortcut/control keys;
- optionally submit a nudge payload that formats voice/typed text before sending.

## Consequences

### Positive

- Mobile can supervise and operate useful workers that do not fit the Farmslot run model.
- Existing tmux/node infrastructure is reused rather than bypassed.
- ADR-032 observability becomes more valuable because its signals can enrich all worker surfaces, not only active runs.
- Operators can use the phone as an actual terminal control surface instead of a read-only monitor.

### Negative / risks

- A full-control terminal from mobile can interrupt or terminate work quickly. This is accepted for V1 because the target user is an authenticated advanced operator.
- General tmux inventory can become noisy. UI filtering/grouping must make active workers easy to identify.
- Signal fusion may produce conflicting state. The UI must expose source/freshness/confidence rather than hide ambiguity.
- Plain shell panes will have weak semantic status unless hooks or task files exist.

### Mitigations

- Keep registered nodes as the trust boundary.
- Label signal source/freshness/confidence.
- Keep inferred summaries visually distinct from hook/status truth.
- Preserve existing run/slot terminal flows.
- Defer background wake-word, auto-send, and remote provisioning.

## Implementation notes — 2026-05-22

- Gateway/node inventory, status fusion, worker-ref terminal methods, Companion worker list/terminal route, shortcut keys, foreground voice nudges, authenticated node redeploy hardening, live tmux parser validation, and optional per-node include/exclude policy are implemented.
- Worker terminals were stabilized onto the existing `pty-stream` + `XtermTerminalView` path after the initial polling implementation caused visible pane flashing. Manual snapshot remains an explicit refresh path only.
- Android real-device validation covered LAN Metro, worker list, worker terminal, xterm/PTY streaming, shortcut controls, and keyboard-aware terminal behavior. iOS simulator launch smoke passed; deeper iOS worker interaction remains follow-up QA.
- Deferred scope remains background wake-word, automatic send without tap, and remote node provisioning/enrollment.
