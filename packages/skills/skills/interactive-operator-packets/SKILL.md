---
name: interactive-operator-packets
description: Communicate complex agent output as compact, reviewable Farmslot operator packets with artifact anchors and safe action requests
compatibility: Claude, Codex, Cursor, and Markdown skill runners with access to the working directory
metadata:
  package: '@farmslot/skills'
  adr: ADR-048
  outputs: artifacts/interactive/*.packet.json and optional sibling markdown when supported
allowed-tools: Read Bash(rg:*) Bash(node:*) Bash(git:*)
---

# Interactive Operator Packets

Use this skill when a plan, decision, blocker, comparison, or evidence review would be easier for the operator to inspect as a structured review packet than as terminal prose.

This skill teaches the communication pattern. It does not assume Farmslot runtime support is installed. If the current project does not support Interactive Operator Packets yet, produce a concise markdown fallback and do not claim that Command Center or Companion can render it.

## Use When

- You need the operator to review a plan before implementation.
- You need a decision with clear options and consequences.
- You found a blocker and need targeted human input.
- You want feedback anchored to a diff, artifact, screenshot, recipe result, or report section.
- You are summarizing evidence and want the operator to approve, reject, or request a revision.

## Do Not Use When

- A one-sentence answer is enough.
- The operator asked for raw terminal output.
- The action would be unsafe without an existing Farmslot confirmation surface.
- You would need to execute arbitrary HTML or JavaScript to make the packet useful.
- The packet would only restate a normal `SIGNAL.json`, recipe manifest, or PR description.

## Packet Contract

When the project supports packets, write JSON to:

```text
artifacts/interactive/<short-id>.packet.json
```

Use this shape:

```json
{
  "schema": "farmslot.interactive.operator-packet.v1",
  "id": "review-plan-1",
  "title": "Review implementation plan",
  "intent": "plan",
  "summary": "Confirm the scoped approach before changes start.",
  "body": {
    "format": "markdown",
    "path": "artifacts/interactive/review-plan-1.md"
  },
  "anchors": [
    {
      "id": "diff-risk",
      "label": "Risky diff area",
      "artifactPath": "artifacts/diff.txt",
      "line": 42
    }
  ],
  "actions": [
    {
      "id": "approve",
      "label": "Approve plan",
      "kind": "terminal.send",
      "safety": "operator-confirmed",
      "payload": {
        "text": "Approved packet review-plan-1. Proceed with the scoped plan."
      }
    }
  ],
  "createdAt": "2026-07-03T00:00:00.000Z"
}
```

Keep `body.text` or the sibling markdown short. A packet is a review surface, not a report dump.

## Writing Rules

1. Start with the operator's next decision or review task.
2. Use a short title and one-sentence summary.
3. Pick one intent: `plan`, `decision`, `review`, `blocker`, `evidence`, or `comparison`.
4. Anchor feedback to concrete artifacts when possible.
5. Offer only actions the operator can understand and confirm.
6. Print a terminal fallback after writing the packet.

Terminal fallback format:

```text
Interactive packet ready: <title>
Packet: artifacts/interactive/<short-id>.packet.json
Fallback: artifacts/interactive/<short-id>.md
```

If Farmslot deep links are known to be supported, also print the route. Never encode a mutating action in the link.

## Action Safety

Allowed v1 action kinds:

- `terminal.send` — send a concise approved response back to the worker.
- `decision.resolve` — resolve an existing Farmslot decision.
- `copy` — copy text for manual use.
- `open-artifact` — open a referenced artifact.

Rules:

- Mark mutating actions as `operator-confirmed`.
- Keep generated `terminal.send` text short and specific.
- Do not hide shell commands inside action payloads.
- Do not ask the UI to execute arbitrary RPC methods.
- Do not treat a deep link as approval.

## Fallback Mode

If packet runtime support is absent:

1. Write the same information as markdown in the conversation or artifact directory.
2. Include anchors as plain file paths and line numbers.
3. Ask for the operator response in normal chat/terminal.
4. Do not say that a packet has been opened, rendered, or sent to Companion.

## Response Handling

When the operator responds to a packet, continue with the referenced packet id and anchor ids:

```text
Received response for packet review-plan-1:
- action: approve
- anchor: diff-risk
- note: Keep the protocol typed; defer HTML.
```

Then act on the feedback through the normal task flow. The packet is a communication aid; the runner session remains the source of execution truth.
