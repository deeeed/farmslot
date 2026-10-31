# Architecture Decision Records

**Owner:** Arthur / Farmslot
**Last updated:** 2026-10-20
**Stale by:** 2026-11-13

ADRs for Farmslot. Some are Command Center-specific, while newer records may apply to the whole Farmslot product.

Bounded changes are dated amendments to the owning ADR. Each amendment retains
its own approval and delivery status; an Accepted base does not accept a Proposed
amendment or establish package publication. ADR numbers are unique.

Reference: [Product Roadmap](../ROADMAP.md) | [ADR implementation status](../reference/adr-implementation-status.md) | [Command Center PRD](../PRD-command-center-canonical.md)

| #                                                        | Decision                                                                | Status   |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| [001](001-gateway-architecture.md)                       | Gateway Architecture — Full TypeScript                                  | Accepted |
| [002](002-tmux-streaming.md)                             | tmux Streaming — Node Agent PTY Attach + WS Push                        | Accepted |
| [003](003-diff-viewer.md)                                | Code Diff & Editor — Monaco Editor                                      | Accepted |
| [004](004-fleet-map.md)                                  | Fleet Map — CSS Grid                                                    | Accepted |
| [005](005-state-persistence.md)                          | State Persistence — In-Memory + JSON Snapshots                          | Accepted |
| [006](006-openclaw-reuse.md)                             | OpenClaw Reuse — Copy + Adapt (Not Plugin/Dependency)                   | Accepted |
| [007](007-project-structure.md)                          | Project Structure — Yarn Workspaces Monorepo                            | Accepted |
| [008](008-remote-communication.md)                       | Remote Communication — Node Agent (Inbound WS)                          | Accepted |
| [009](009-slot-workspace.md)                             | Slot Workspace — Read-Only IDE View via FS/Git RPC                      | Accepted |
| [010](010-slot-view-layout.md)                           | Slot View Layout — Unified IDE-Like Interface                           | Accepted |
| [011](011-structured-task-tracking.md)                   | Structured Task Tracking — Markdown-First Derived Schema                | Accepted |
| [012](012-device-screen-streaming.md)                    | Device Screen Streaming — H.264 via scrcpy/ScreenCaptureKit + WebCodecs | Accepted |
| [013](013-gateway-mediated-orchestration.md)             | Gateway-Mediated Orchestration — Run State Machine                      | Accepted |
| [014](014-llm-provider-abstraction.md)                   | LLM Provider Abstraction — pi-ai Multi-Provider                         | Accepted |
| [015](015-resource-streams.md)                           | Resource Streams — Project-Driven Multi-Stream Model                    | Accepted |
| [016](016-d9-copilot.md)                                 | D9 Co-Pilot — Fleet Observer + Conversational Interface                 | Accepted |
| [017](017-llm-task-summaries.md)                         | LLM Task Summaries & Smart Branch Naming                                | Accepted |
| [018](018-dev-flow-interactive-autonomous.md)            | Dev Flow & Interactive/Autonomous Modes                                 | Accepted |
| [019](019-recipe-graph-visualization.md)                 | Recipe Graph Visualization                                              | Accepted |
| [020](020-agent-to-node-rename.md)                       | Terminology Rename — Agent → Node                                       | Accepted |
| [021](021-llm-enhanced-orchestration.md)                 | LLM-Enhanced Orchestration                                              | Accepted |
| [022](022-slot-lifecycle-simplification.md)              | Slot Lifecycle Simplification — 5-State Machine                         | Accepted |
| [023](023-runner-agnostic-tui-execution.md)              | Runner-Agnostic TUI-First Execution                                     | Accepted |
| [024](024-run-lanes-and-run-family-model.md)             | Run Lanes and Run-Family Model                                          | Accepted |
| [025](025-run-family-observability.md)                   | Run Family Observability                                                | Accepted |
| [026](026-self-improvement-recursive-loop.md)            | Self-Improvement Recursive Loop                                         | Proposed |
| [027](027-unified-gateway-state.md)                      | Unified Gateway State                                                   | Accepted |
| [028](028-pr-dashboard-github-quota.md)                  | PR Dashboard GitHub Quota Strategy                                      | Accepted |
| [029](029-production-logging-intelligence-evidence.md)   | Production Logging and Intelligence Evidence Registry                   | Accepted |
| [030](030-replay-provenance-and-reference-evals.md)      | Evaluation Packages and Reference Evals on Run Families                 | Accepted |
| [031](031-deterministic-first-auto-recovery.md)          | Deterministic-First Auto-Recovery                                       | Accepted |
| [032](032-runner-observability-via-hooks.md)             | Event-Driven Runner Observability via Hooks and Signal Files            | Accepted |
| [033](033-mobile-tmux-worker-control.md)                 | Mobile Control of General Tmux Workers                                  | Accepted |
| [034](034-recipe-protocol-v1.md)                         | Recipe Protocol v1, bounded HUD intent and log observations             | Accepted |
| [035](035-node-support-bundles.md)                       | Node Support Bundles                                                    | Accepted |
| [036](036-cli-gateway-profiles.md)                       | CLI Gateway Profiles and Auth                                           | Accepted |
| [037](037-prepare-profiles.md)                           | Prepare Profiles — Project-Defined Slot Entry Points                    | Accepted |
| [038](038-gate-held-worker-session.md)                   | Gate-Held Worker Session at Publication Human Gate                      | Accepted |
| [039](039-run-portable-bundles.md)                       | Portable Run Bundles for Cross-Gateway Reference Seeding                | Accepted |
| [040](040-work-graph-orchestration.md)                   | Work-Graph Orchestration for Backlog Dependency DAGs                    | Accepted |
| [041](041-roadmap-idea-refinement-layer.md)              | Operator Roadmap Idea Refinement Layer                                  | Proposed |
| [042](042-slot-tracking-branches.md)                     | Slot Tracking Branches for Worktrees and Idle State                     | Accepted |
| [043](043-scripted-runner-execution-policy.md)           | Scripted Runner and Per-Step Executor Policy                            | Proposed |
| [044](044-backlog-launch-plans.md)                       | Backlog Launch Plans and Comparison Candidate Sets                      | Accepted |
| [045](045-worker-terminal-contract.md)                   | Worker Terminal Contract — project.json required outputs                | Accepted |
| [046](046-mandatory-local-node.md)                       | Mandatory co-located local node                                         | Proposed |
| [047](047-worker-session-history-panel.md)               | Experimental Worker Session History Panel (transcript mirror)           | Accepted |
| [048](048-interactive-operator-packets.md)               | Interactive Operator Packets for Agent Review Surfaces                  | Accepted |
| [049](049-agent-execution-template-selection.md)         | Agent Execution Template Selection                                      | Accepted |
| [050](050-dual-mode-cli-ink-tui.md)                      | Dual-mode CLI architecture and Ink TUI                                  | Accepted |
| [051](051-principal-and-credential-model.md)             | Principal and credential model                                          | Accepted |
| [052](052-recipe-derived-visual-review-boards.md)        | Recipe-Derived Visual Review Boards                                     | Accepted |
| [053](053-run-lifecycle-transition-routing.md)           | Run Lifecycle Transition Routing                                        | Accepted |
| [054](054-run-resource-posture.md)                       | Run Resource Posture at Lifecycle Boundaries                            | Proposed |
| [055](055-persistent-pr-monitoring-and-review-intake.md) | Persistent PR monitoring and review intake                              | Proposed |
| [056](056-runner-session-archive.md)                     | Opaque runner session archive at recycle (ADR-047 follow-up)            | Accepted |
| [057](057-structured-runner-transports.md)               | Structured runner transports                                            | Accepted |
| [058](058-static-review-and-farm-owned-qa.md)            | Static review and farm-owned QA; optional-default amendment accepted    | Accepted |
| [059](059-pi-tui-model-agnostic-runner.md)               | PI TUI as a model-agnostic Farmslot worker                              | Accepted |
| [060](060-sub-task-observability.md)                     | Sub-task observability through child checklist units                    | Accepted |
| [061](061-structured-assessment-providers.md)            | Structured assessment providers                                         | Accepted |
| [062](062-recorded-run-evidence.md)                      | Recorded run evidence, shared review curation and saved results         | Accepted |
| [063](063-review-modes-warm-cold.md)                     | Review modes WARM and COLD with one shared review-and-dispatch picker   | Accepted |
| [064](064-deterministic-checklist-checks.md)             | Deterministic checklist checks and CI decision check context            | Accepted |
| [065](065-fail-closed-run-lifecycle.md)                  | Fail-closed run lifecycle                                               | Accepted |
| [068](068-project-recipe-binding-and-conformance.md)     | Project recipe binding and conformance                                  | Accepted |
| [069](069-declared-pinned-sources.md)                    | Declared and pinned farm sources                                        | Accepted |
| [071](071-gateway-change-notifications.md)               | Gateway change notifications and shared client cache                    | Accepted |

ADR-071 has an Accepted [persistent client store amendment](071-gateway-change-notifications.md#amendment-1-2026-10-20-persistent-client-store).
Its specification gains an [Offline client store](../reference/gateway-change-notifications.md#offline-client-store)
section, which describes offline data on Command Center, its desktop app and
Companion end to end. ADR-009 has an Accepted
[conditional file edits amendment](009-slot-workspace.md#amendment-1-2026-10-20-conditional-file-edits)
that replaces its read-only decision.

ADR-039 has an Accepted [settled-run retention amendment](039-run-portable-bundles.md#amendment-2-2026-10-20-settled-run-retention): an hourly gateway pass deletes done, cancelled and archived runs 48 hours after they settle, with the storage only they own.

ADR-039 has an Accepted [gateway-retained artifact amendment](039-run-portable-bundles.md#amendment-1-2026-10-15-gateway-retained-run-artifacts) and [normative retention specification](../reference/retained-run-artifacts.md). The lead accepted the amendment on 2026-10-15 at `978e2e27`; implementation remains pending.

ADR-039 has an Accepted [run-end episode amendment](039-run-portable-bundles.md#amendment-4-2026-11-01-run-end-episode-capture): every run that ends records one `farmslot-episode-v1` reference file beside its record, written by an advisory transition effect and retried by the hourly retention pass.

ADR-062 includes accepted [completed evidence and storage](062-recorded-run-evidence.md#completed-evidence-review-and-run-footprint) design, with implementation pending, and shipped [review curation/results](062-recorded-run-evidence.md#shared-review-curation-and-saved-results). Its [evidence-policy amendment 3](062-recorded-run-evidence.md#amendment-3-2026-10-13-evidence-policy-and-human-attestation) is Accepted under [#1011](https://github.com/deeeed/farmslot/pull/1011). Attested approval shipped there; normal-policy binding rules remain separate implementation.

Its [verified-override amendment 4](062-recorded-run-evidence.md#amendment-4-2026-10-13-verified-untestable-overrides-and-selected-execution) is Accepted under [#1015](https://github.com/deeeed/farmslot/pull/1015); implementation is recorded separately.

Its [selected-evidence amendment 5](062-recorded-run-evidence.md#amendment-5-2026-10-14-selected-evidence-and-run-contract-version) defines the creation-time run contract version and engine-derived publication selection.

Its [authenticated-visual-review amendment 6](062-recorded-run-evidence.md#amendment-6-2026-10-14-authenticated-visual-review-and-qa-binding) is accepted and implemented in [#1037](https://github.com/deeeed/farmslot/pull/1037). Its [delegated-review and Compare by AC amendment 7](062-recorded-run-evidence.md#amendment-7-2026-10-14-delegated-visual-judgments-and-compare-by-ac) is accepted on 2026-10-14; delegated judgments ship first, then comparison. Implementation and live gate acceptance are pending.

Its [retained-link amendment 8](062-recorded-run-evidence.md#amendment-8-2026-10-14-retained-criterion-link-snapshots) is Proposed for the #1044 cutover. Import and rollout remain pending.

ADR-040 has a [Accepted retained-run attachment amendment](040-work-graph-orchestration.md#amendment-3-retained-run-stack-attachment) and [normative specification](../reference/stacked-work.md). The base decision remains Accepted.
