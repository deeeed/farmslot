# ADR-048: Interactive Operator Packets for Agent Review Surfaces

**Status:** Accepted
**Date:** 2026-07-03

## Context

Farmslot workers communicate through runner CLIs in tmux. That keeps execution visible, steerable, and subscription-backed, but it pushes complex agent output into a surface that is hard to review: long prose, terminal scrollback, ANSI noise, and ad hoc "please choose A/B/C" prompts. Command Center and Companion already render run artifacts, terminal streams, decisions, recipe evidence, and transcript-backed worker history, but there is no small protocol for an agent to say: "open this structured review surface, annotate or choose here, and send the result back through the runner."

External artifact editors such as Lavish show the useful pattern: the agent is taught by a skill to create a rich artifact, open a local review surface, poll for human feedback, revise, and end the session. Farmslot should adopt the underlying loop, but not copy the HTML-first contract as the default. Farmslot already has typed artifacts, run identity, decisions, terminal input, Companion, and evidence manifests. A Farmslot-native design should start with typed packets that reference those existing artifacts.

This ADR is adjacent to [ADR-047](047-worker-session-history-panel.md), but not the same feature. ADR-047 mirrors worker history for review. This ADR proposes a forward channel: agent-authored, operator-reviewable packets with structured actions and feedback anchors.

## Decision

Introduce **Interactive Operator Packets** as a proposed Farmslot protocol and skill pattern.

An Interactive Operator Packet is a durable run artifact that describes a review surface the agent wants the operator to inspect. It is rendered by Farmslot surfaces when supported and falls back to terminal links or markdown when unsupported.

### Packet shape

The initial protocol should be JSON-first and narrow:

```ts
interface InteractiveOperatorPacket {
  schema: 'farmslot.interactive.operator-packet.v1';
  id: string;
  runId?: string;
  title: string;
  intent: 'plan' | 'decision' | 'review' | 'blocker' | 'evidence' | 'comparison';
  summary?: string;
  body: {
    format: 'markdown';
    path?: string;
    text?: string;
  };
  anchors?: InteractiveOperatorAnchor[];
  actions?: InteractiveOperatorAction[];
  createdAt: string;
}

interface InteractiveOperatorAnchor {
  id: string;
  label: string;
  artifactPath?: string;
  selector?: string;
  line?: number;
  range?: { start: number; end: number };
}

interface InteractiveOperatorAction {
  id: string;
  label: string;
  kind: 'terminal.send' | 'decision.resolve' | 'copy' | 'open-artifact';
  safety: 'read-only' | 'operator-confirmed';
  payload?: Record<string, unknown>;
}
```

The packet body may reference a sibling markdown artifact. Anchors may point at existing run artifacts, diffs, screenshots, recipe manifests, or text ranges. Actions are declarative and must be interpreted by the gateway/UI, not executed by opening a URL.

### Skill as part of the protocol

The protocol requires a paired agent skill. The schema alone is insufficient because the agent must learn:

- when to emit a packet instead of terminal prose;
- how to keep packets short and reviewable;
- how to anchor comments to artifacts, diffs, screenshots, and evidence;
- how to print terminal fallback links;
- how to route operator replies back through the runner rather than starting a parallel model session.

Farmslot should package this guidance in `@farmslot/skills` as `packet` so operators can type `$packet` instead of a long protocol name. In a Farmslot run, project worker templates can mention the skill when they want packet-style communication. Outside Farmslot, the same skill can still teach agents to produce a markdown + JSON packet artifact without claiming Command Center support exists.

### Surface behavior

| Surface                  | Behavior                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Terminal / tmux          | Prints a short invitation and fallback path/link, never the whole packet unless requested |
| Command Center           | Renders packet cards/workspaces on run detail, ready/review workspaces, or slot view      |
| Mobile Companion         | Renders a compact packet reader with safe confirmed actions                               |
| Worker session history   | Shows packet creation as a structured turn marker, not as duplicated full content         |
| Artifacts / eval package | Stores packets as evidence of human-agent interaction                                     |

Deep links may navigate to a packet (`#run/<id>?packet=<packet-id>` or a mobile route equivalent). Deep links must not execute actions. Every mutating action remains behind gateway auth and an operator confirmation surface.

### Feedback path

Feedback should flow back through existing worker channels:

1. Operator reviews the packet in Command Center or Companion.
2. UI records a structured response (`actionId`, `anchorId`, free text, timestamp).
3. Gateway converts approved feedback into the existing runner input path, typically `terminal.send` or decision resolution.
4. The worker receives one concise message containing the operator response and the packet/anchor ids.

Do not call model APIs from the gateway to "continue" the worker. ADR-023's TUI-first execution model remains intact.

### HTML and custom UI

Arbitrary HTML is deferred. A later version may allow sandboxed HTML packets, but v1 should use markdown, typed anchors, and known artifact viewers. This keeps the protocol useful on mobile, easier to validate, and safer around local files.

Full Lavish-style integration remains a later roadmap idea, not part of v1. That would mean adopting a richer artifact-review/editor loop with local HTML sessions, element/text annotations, feedback polling, layout warnings, and possibly a terminal-openable editor outside Command Center. Before pursuing it, Farmslot should re-plan the ownership boundary: whether to integrate Lavish directly, copy selected patterns, or keep the current typed-packet protocol as the primary operator interaction surface and treat rich HTML review as an optional artifact viewer.

## Consequences

### Positive

- Reduces terminal wall-of-text for plans, blockers, comparisons, and evidence review.
- Gives Companion a compact interaction model for agent supervision.
- Makes operator feedback more precise by anchoring it to artifacts and packet sections.
- Creates durable human-agent interaction evidence for evals and retrospectives.
- Preserves runner-owned execution and subscription economics.
- Lets external projects adopt the communication style through `@farmslot/skills` before full Farmslot integration.

### Negative / risks

- Adds another artifact type that must not compete with decisions, recipe manifests, or worker history.
- Poor packets could become glossy prose dumps unless the skill is strict.
- UI support must be honest about unsupported packets and degraded modes.
- If actions become too broad, the packet protocol can accidentally duplicate gateway RPC policy.

### Non-goals

- Replacing tmux terminal control.
- Replacing ADR-047 worker history.
- Gateway-owned model chat with the worker.
- Arbitrary remote or local HTML execution in v1.
- Action execution from unauthenticated or unaudited URLs.
- Making every worker response a packet.

## Implementation phases

1. **Skill seed:** ship the `packet` skill in `@farmslot/skills` so agents can discuss and draft packet-shaped output.
2. **Protocol types:** add packet contracts to `@farmslot/protocol` and index packet artifacts from run artifact manifests.
3. **Command Center renderer:** render packet cards on run detail with artifact anchors and confirmed `open-artifact`, `copy`, `terminal.send`, and `decision.resolve` actions.
4. **Companion renderer:** add compact packet rendering and the same confirmed action model.
5. **Eval/replay integration:** preserve packet/response records inside result packages.

## Related

- [ADR-023](023-runner-agnostic-tui-execution.md) — runner-owned TUI execution remains the input channel
- [ADR-032](032-runner-observability-via-hooks.md) — hook/event observability can correlate packet turns
- [ADR-034](034-recipe-protocol-v1.md) — typed artifacts and manifests are the precedent
- [ADR-047](047-worker-session-history-panel.md) — worker history is the review lens this complements
- [PRD-command-center-canonical.md](../PRD-command-center-canonical.md) — primary desktop surface
- [PRD-mobile-companion-canonical.md](../PRD-mobile-companion-canonical.md) — compact supervision surface

## Open questions

- Should packet artifacts live under `artifacts/interactive/` or be manifest entries with `type: "interactive-packet"` regardless of path?
- Should packet responses become a new artifact file or be folded into existing decisions?
- How much of the first renderer belongs in generic artifact rendering versus run-detail-specific UI?
- What is the minimum packet response record needed for eval replay?
- Is a future Lavish-style HTML editor worth the dependency/runtime cost, or should Farmslot keep rich review surfaces limited to typed artifacts plus existing artifact viewers?
