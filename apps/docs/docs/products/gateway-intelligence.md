---
title: Gateway Intelligence product
---

# Gateway Intelligence product

Gateway Intelligence is the operator-facing automation layer that makes Farmslot more than a launcher.

It reduces coordination toil while keeping evidence, decisions, and escalation paths visible.

<video class="product-image" src="/videos/demos/command-center-gateway-intelligence.mp4" poster="/img/demos/command-center-gateway-intelligence.png" controls muted playsinline preload="metadata" aria-label="Gateway intelligence answering a fleet status question from Command Center"></video>

## Product jobs

| Job       | Operator value                                                                        |
| --------- | ------------------------------------------------------------------------------------- |
| Score     | Help decide what work is ready and which runner/slot should take it.                  |
| Monitor   | Detect stuck, drifting, or unhealthy runs before the operator has to poll terminals.  |
| Nudge     | Send context-aware steering while preserving a visible audit trail.                   |
| Summarize | Turn run state, artifacts, and diffs into reviewable briefs.                          |
| Review    | Highlight weak evidence, risky changes, and cross-runner disagreements.               |
| Recover   | Propose typed recovery actions for known transient failures.                          |
| Improve   | Convert accepted learnings into proposed prompt, template, recipe, or config changes. |

## Product boundary

Gateway Intelligence should never become hidden autonomy. It should propose, summarize, and route with evidence.

The operator still decides when to approve, recover, publish, or apply self-improvement changes.

For implementation mechanics, see [Gateway intelligence architecture](../architecture/gateway-intelligence.md).
