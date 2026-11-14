# Farmslot — Runner-Agnostic Execution Canonical PRD

This canonical chunk PRD defines runner-agnostic execution within the Farmslot hierarchy described by [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It is the shared execution contract for tmux sessions and opt-in native structured sessions.

## Scope

Runner-Agnostic Execution owns the execution contract shared across Claude, Codex, OpenCode, and future runners:

- TUI-first launch semantics as the default operating mode
- opt-in native structured transports for clients that operate without tmux
- runner capability modeling for prompt delivery, nudging, monitoring, resume, and recovery
- safety tiers and prompt/policy handling
- runner-neutral recovery artifacts and compatibility shims
- the contract that command surfaces and automation layers consume when dealing with different runners

## User Outcome

An operator should be able to supervise different agent runners through one Farmslot execution model without losing visibility, control, or safety semantics when the underlying runner changes.

## Canonical Current State

- Runner-neutral tmux supervision and the approved native transport rollout are shipped. The PI TUI worker (`runner=pi`, default `grok-4.6`) is the first model-agnostic harness ([ADR-059](adr/059-pi-tui-model-agnostic-runner.md)). OpenCode TUI+ACP remains a fallback. Rules shims remain separate roadmap work.
- The approved native structured transport rollout is shipped under [ADR-057](adr/057-structured-runner-transports.md). PRs #615 and #616 delivered adapters and durable sessions, #618 delivered Command Center, #619 and #620 delivered remote foundations, and #635 completed workers, retained reviewers, parking, Companion, additional standalone runners, and account setup.
- Profiles select native configuration directories for one trusted operator per OS user; each product user owns their execution node. This is not isolation between mutually untrusted users sharing an OS account. Current validation and deferred scope are recorded in the [completed rollout](ROADMAP-next.md#structured-runner-transports).

## Requirements

### 1. TUI-first by default

Farmslot runners launch in inspectable, operator-attachable TUI sessions by default. A flow may explicitly select a validated native structured transport. Existing sessions keep their transport; loading a saved session does not imply attachment to its running TUI process.

### 2. Runner-neutral capability model

Prompt handling, progress observation, nudging, resume, recovery, and safety behavior must be expressed in a runner-neutral contract.

#### Saved-session continuation

Under ADR-023 Amendment 2, every adapter MUST declare saved-session continuation
for each supported transport, or explicitly declare it unsupported. WARM MUST
use this declaration instead of separate reload, handoff, workspace-session or
native-task-reuse support gates. Those fields may govern their other operations.
The shared command adapter MUST use that
declaration for exact-session resume arguments. A resume MUST NOT select the
latest session, open a picker or silently create a different conversation.

A workspace-scoped continuation MUST retain its source checkout path. Transfer
MUST verify the stopped predecessor, owner generation, project, repository/PR,
runner, model, effort, session and reviewed head, and preserve earlier task
artifacts. Only one run may own the workspace and conversation at a time.
Cleanup and replay MUST respect the predecessor run record's durable successor
ownership marker. The successor keeps a separate task directory, so updating
the source head cannot overwrite earlier artifacts. Acceptance MUST identify
the exact saved session through structured runner evidence.

The gateway's existing launch and WARM review paths consume this private
capability. No public command, flag, SDK export or app-harness extension is added.

#### Continuation compaction

Under proposed ADR-023 Amendment 3, adapters own compaction syntax and structured
same-session evidence for each transport, or declare it unsupported. Only a new
review continuing a validated verdict opts in. Worker launches and unfinished
same-attempt recovery do not compact.

Compaction runs inside an accepted saved-session continuation. Every existing
identity, owner/generation/lease, runner, account/profile, model, effort, workspace,
idle/busy and capacity fence applies. Before rebinding incoming task instructions,
retain reviewed heads, findings and audit references while retiring obsolete task
commands. Compaction cannot inspect source, produce a verdict or terminal mark,
or add a reviewer round; existing usage accounting still applies.

Before sending, persist a pending operation in the run snapshot's
`ReviewSessionTrace.compaction`, keyed by lineage, exact provider session and frozen
packet digest. Persist structured completion evidence there before delta delivery.
Restart/reattach reconciles that operation, never blindly resends it. A timeout or
TUI text is not completion. Recheck the continuation fences before delivery.

Unsupported compaction records its reason and delivers the delta uncompacted to
the same accepted session; it does not trigger COLD or alter accounting. Unconfirmed
compaction stops delta delivery and follows ADR-063's uncertain-delivery path:
reconcile the same reserved context/lease/operation once, without launching a
replacement or settling a verdict. Continued uncertainty remains blocked. Only a
confirmed stopped, unaccepted launch may use the existing infrastructure-fallback
settlement and replacement policy.

Gateway review continuation consumes this capability. Optional compaction methods
on `NativeAdapterSession` and `NativeSessionClient` belong to
`@farmslot/agent-runtime/native`; optional trace fields belong to
`@farmslot/protocol`. These additive SDK changes require reviewed pre-1.0 minor
publication and matching node capability negotiation. Internal node/native
maintenance carries the operation; no public gateway method, CLI flag or harness
extension is added.

### 3. Explicit safety tiers

Dangerous or highly autonomous launch modes need a shared vocabulary and warning model across runners.

### 4. Shared recovery artifacts

Recovery instructions and compatibility shims must be portable enough that future runners can integrate without inventing bespoke operator recovery rules.

### 5. Product-wide consumption

Command Center, automation/orchestration, and core platform layers must consume this model rather than each defining runner behavior independently.

#### Runner account inventory

Config and Fleet display the same read-only host-default inventory of runners,
providers and account entries. A runner can report several providers concurrently;
there is no implied single active account for Pi or OpenCode. Runner status adapters
own discovery and credential checks. The protocol distinguishes stored credentials
from reported readiness, identity and quota. Refresh does not change credentials,
dispatch bindings or running sessions, and never copies tokens between nodes.
Each capable adapter also supplies a copy-only manual inspection command. Remote
commands target the selected execution host over SSH. Only configuration-directory
overrides enter copied commands; API keys and tokens never do. Command descriptions
distinguish account identity, provider readiness and saved credential presence.

Pi inventories saved logins in `PI_CODING_AGENT_DIR` or its default directory and
checks each through its configured executable's structured auth command without
refreshing OAuth. OpenCode inventories its default XDG credential store or
`OPENCODE_AUTH_CONTENT`; configured credentials do not prove readiness. Environment-only
and project-specific providers, wrapper-private directories, and additional named
native profiles are outside this default-configuration inventory. Configure directory
overrides in the pool environment so discovery and launch agree. Existing runner
identity/quota adapters retain their source and account-binding behavior. Unknown
identity and quota remain unknown; credential presence does not prove subscription billing.

### 6. Native structured sessions

Reasoning labels use the adapter's serialized request receipt when available. An omitted
setting displays `default`, an explicit disable displays `off`, and a level displays its
wire value. The receipt is bound to the worker's session, model and attempt for either
transport. Runs without a receipt retain their existing effort label.

Runner adapters own native protocol mechanics and declare supported interactions. Clients consume shared session commands and events for text, tools, approval, questions, interruption, and recovery. Acceptance, turn start, and turn completion are separate facts. Missing structured evidence remains unknown; unsupported operations fail closed.

Each session has one authoritative input owner and a durable identity bound to its execution node, runner, account context, and native session. Commands and approval replies retain correlation IDs. An account switch cannot reuse another account's process, transcript, or pending request.

The execution node supervises the process independently of gateway and client connections. Persisted events support cursor-based replay. Recovery must report uncertainty and must not resend an accepted prompt. Execution-node loss does not promise process survival.

Users install and authenticate the native runner in their own execution context. Farmslot preserves native tools, authentication, and permission controls. Shared deployments require enforced principal and execution isolation under [ADR-051](adr/051-principal-and-credential-model.md). A shared gateway credential is not proof of account isolation. Subscription eligibility and billing need provider-specific evidence; inference success and token estimates cannot establish them. No automatic paid-API fallback is implied.

### Client integration contract

Command Center adds an opt-in structured interface within Copilot. Users retain supported runner/model selection, execution context, and the regular tmux flow. Streamed text, expandable tools, approvals/questions, interruption, and recovery consume server-declared capabilities and durable session identity. Refresh restores the same session and pending requests; connection loss cannot trigger a new prompt submission.

The approved interface includes read-only source and Git diff views. Gateway lookup binds each file/diff request to the authorized session and its recorded working directory, preserving path boundaries. Files/Changes report current workspace state and the comparison scope, without inventing per-turn checkpoints or attributing every edit to the agent. [DESIGN.md](../DESIGN.md) owns layout, accessibility, and T3-inspired interaction choices. Existing archive/history readers must retain coherent native session identity.

### 7. Validation and rollout

Prove Codex and Claude through production gateway RPC before releasing client controls. Extend the same live scenarios to remote workers, retained reviewers, Command Center, Companion, Grok, and Cursor. Each runner must pass its declared capabilities, including reconnect and negative ownership checks. Existing tmux acceptance and retained-handoff scenarios remain required. See the phased gates in [ADR-057](adr/057-structured-runner-transports.md#validation-and-rollout).

## Boundaries

- This chunk defines the execution contract, not the desktop or mobile UX around it.
- It depends on Core Farmslot for slot/runtime infrastructure.
- It is consumed by automation and control-surface layers, but they do not own its semantics.
- Replacing native agent loops with PI, importing a complete third-party UI, and taking over arbitrary live TUI sessions are outside the structured-transport rollout.

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- ADR-023, ADR-024, ADR-025, ADR-027, ADR-043
- [ADR-057: Structured runner transports](adr/057-structured-runner-transports.md)

## Success Condition for This Chunk

Farmslot can operate multiple agent runners through one inspectable, recoverable execution contract. Clients can use validated native structured sessions without tmux, while existing tmux workflows retain their behavior.
