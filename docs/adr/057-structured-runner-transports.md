# ADR-057: Structured runner transports

**Status:** Accepted; local adapters, durability and Command Center shipped; worker/node integration in progress
**Date:** 2026-09-12
**Scope:** [Runner execution PRD](../PRD-runner-execution-canonical.md), [near-term roadmap](../ROADMAP-next.md)
**Related:** [ADR-023](023-runner-agnostic-tui-execution.md), [ADR-032](032-runner-observability-via-hooks.md), [ADR-047](047-worker-session-history-panel.md), [ADR-051](051-principal-and-credential-model.md)
**Lifecycle:** Keep as the accepted decision for the native transport option. This adds an explicit alternative to ADR-023's default without rewriting historical tmux decisions.

## Context

Farmslot controls interactive runners through tmux. Terminal rendering differs by runner and does not reliably identify messages, tool results, permissions, or completed turns. Native history files improve read-only review but do not provide a complete input and event protocol.

Farmslot needs shared session controls in Command Center, Companion, CLI, and worker orchestration, including when a client cannot attach to tmux. Users must retain their own native runner accounts in both private farms and shared deployments.

## Decision

### Keep native runtimes and make transport explicit

The runtime owns the agent loop, tools, compaction, and authentication. The transport carries commands and events between that runtime and Farmslot. A Farmslot session identifies its execution node, runner, account context, native session, and selected transport independently of any terminal pane.

Keep tmux as the default. Add opt-in structured transports within the shared runner capability layer, starting with Codex app-server and the unmodified Claude structured process. Add Grok and Cursor through ACP and choose OpenCode ACP or its native server according to demonstrated capabilities. Record the resolved executable, runner version, account mode, and negotiated capabilities for each launch. Unknown capabilities remain unavailable.

Existing tmux sessions continue through their current adapter. New native sessions do not require tmux. Saved-session resume and attachment to an existing process are separate capabilities. Arbitrary live TUI takeover is outside this decision.

### One command and event contract

Runner adapters own framing, native request IDs, launch syntax, permission handling, and event conversion. Workflow and client code consume shared capabilities without runner-name branches or terminal-text parsing.

The contract distinguishes command acceptance, turn start, text deltas, tool activity and results, permission requests, user questions, interruption, turn completion, and process failure. Preserve native IDs where available and correlate commands and pending requests with their session. Output silence, terminal redraws, and a successful write to stdin cannot establish turn completion or delivery acceptance.

Unsupported interactions fail closed. Missing evidence is unknown, never successful delivery or idle state. Native permission decisions keep their scope; transport access grants no additional dispatch, publication, merge, or execution authority.

### Durable ownership and recovery

Each session has one authoritative input owner on its execution node. Clients submit commands through the gateway to that owner. A tmux driver and a native adapter cannot independently write to the same session.

Use a supervised process on the execution node whose lifetime does not depend on a browser or gateway connection. Reuse node execution mechanisms where they meet that requirement. Persist session identity, command correlation, pending requests, and ordered events before acknowledging durable mutations. Replay uses cursors; duplicate commands retain their original outcome instead of delivering the prompt twice.

Worker dispatch must reserve and persist a lowercase session UUID before launch, then call `native.session.ensure`. Retrying that operation requires the same owner and launch configuration and returns the existing session, including closed or failed state. It never relaunches a terminal reservation. Ordinary `native.session.create` still creates a new session or explicitly resumes a saved conversation. The gateway requires the node to declare `supportsEnsure` before routing reserved creation; a newer client also refuses ensure against a retained host without that capability while preserving its ordinary session controls.

On reconnect, restore events and pending approvals for the same account and session. On process death, report the terminal state and offer saved-session resume only when the adapter verifies it. A crash between delivery and acknowledgment may leave acceptance unknown. Recovery must reconcile structured evidence or require explicit resolution rather than resend automatically. Node loss does not guarantee process survival.

History and archive readers reuse the native session identity and ownership boundary. Reconcile archive schema changes before integration so live events and archived messages do not create competing session records.

### Native authentication and account isolation

Users install and sign into the native runner in their execution context. Farmslot does not collect subscription tokens in shared application state, route them into PI, impersonate an official client, or silently switch to paid API credentials. The runtime keeps its native authentication and tool behavior.

Account context comes from authorized execution context, not an arbitrary client-supplied label. Bind launch, history access, commands, and approval replies to that context. Account switching requires a distinct process and session context; stale replies cannot reach the new account. Keep credentials out of event history and client payloads.

Native node execution requires an issued node credential bound to the exact machine and `FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID` set on that node. `deploy-node.sh` carries this opt-in into its service environment. The node keeps native journals under its own Farmslot home and retains runner installation and login locally. Session and workspace requests include `executionNodeId`; omission continues to select the gateway host. Replacing a node connection cannot answer requests sent to the previous connection, and a missing node never redirects a session to the gateway host.

The first implementation is experimental and restricted to a pinned principal in a single trusted operator context. The account-setup phase adds user-owned execution profiles. Shared deployments require principal authorization and execution isolation consistent with ADR-051. Separate account labels under one unrestricted OS user do not establish a security boundary. Do not advertise multi-user account isolation until process, filesystem, and credential access checks prove that boundary.

Successful inference establishes access at the time of the request. Subscription entitlement, permitted automation, quotas, and billing require separate provider-specific evidence. Compare equivalent native TUI and structured tasks using provider usage records where available. Mark unavailable or delayed billing evidence explicitly. Initialization and estimated token cost cannot establish subscription economics.

### Client integration and code reuse

Command Center first consumes structured sessions through the existing Copilot UI. Workers, retained reviewers, remote nodes, and Companion then consume the same commands and events. Keep terminal viewing for tmux sessions and visibly disable interactions an adapter cannot provide.

T3's MIT-licensed adapter code may be copied where useful, with required notices and dependency license checks. Do not import its whole application architecture. PI remains a possible later runtime; PI-TUI is terminal rendering and does not replace this client protocol.

## Validation and rollout

G003's broader recovery proof found documented Claude Code 2.1.78 history-loss
defects that the earlier user-prompt recall test did not detect. Native Claude
recovery is therefore gated to sessions started with 2.1.265 or newer. Older
sessions remain readable/closeable and expose the unsupported capability. Test
tool-result and assistant-message context, not only tokens from user prompts.

G001 shipped in PR #615 with live-validated local Codex and Claude adapters. G002 shipped in PR #616 with local process supervision, durable events, replay, and recovery validation. G003 Command Center integration shipped in PR #618. G004 worker and retained-reviewer integration, remote execution, and Companion are current; additional runners and isolated user-account setup remain pending. The trusted local principal restriction still applies; these results do not establish shared-account isolation or subscription billing.

| Phase | Deliverable                                         | Required proof                                                                                                                                                              |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Canonical contract and rollout                      | Explicit tmux defaults, ownership, account boundary, and capability gates                                                                                                   |
| 1     | Codex and Claude through gateway RPC                | Acceptance, streaming, benign tool result, approve and deny, questions where supported, interrupt, second-turn context, saved-session resume, and matching tmux regressions |
| 2     | Node supervision and durable events                 | Client and gateway reconnect, two concurrent sessions, replay without duplication, process failure, uncertain acceptance, stale and cross-account request rejection         |
| 3     | Native Copilot in Command Center                    | Complete a task through real controls without tmux; CDP and gateway assertions prove approval, interruption, refresh, and pending-request recovery                          |
| 4     | Workers, retained reviewers, remote node, Companion | Real dispatch and handoff, second-machine execution, reconnect, mobile approval and continuation of the exact session, and tmux compatibility                               |
| 5     | Grok, Cursor, OpenCode, account setup               | Each declared capability passes the common suite; native installation/login and account switching preserve isolation                                                        |

Use production gateway scenarios in `scripts/runner-validation/`. Unit tests guard regressions but do not establish runner behavior. Every new live assertion needs a negative check that demonstrates it can fail. Browser validation drives real controls without injecting UI state. Keep bounded provider usage observations separate from protocol evidence and private account details outside public docs.

Keep an adapter experimental if interactive permissions or exact session continuity fail. Do not release client controls for an unproven capability. All phases are approved work, and initialization-only probes do not complete phase 1.

## Consequences

Farmslot can present agent sessions without terminal rendering while retaining native runner behavior. Protocol version changes become adapter maintenance, with capability checks and live scenarios guarding compatibility.

This decision adds durable process and event ownership to the execution node. It requires explicit account isolation before shared-account product claims. It does not establish cheaper inference, unlimited unattended use, or subscription permission for a custom PI runtime.
