# Architecture Decision Records

**Owner:** Arthur / Farmslot
**Last updated:** 2026-06-08
**Stale by:** 2026-09-08

ADRs for Farmslot. Some are Command Center-specific, while newer records may apply to the whole Farmslot product.

Reference: [Product Roadmap](../ROADMAP.md) | [Command Center PRD](../PRD-command-center-canonical.md)

| #                                                      | Decision                                                                | Status   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | -------- |
| [001](001-gateway-architecture.md)                     | Gateway Architecture — Full TypeScript                                  | Accepted |
| [002](002-tmux-streaming.md)                           | tmux Streaming — Node Agent PTY Attach + WS Push                        | Accepted |
| [003](003-diff-viewer.md)                              | Code Diff & Editor — Monaco Editor                                      | Accepted |
| [004](004-fleet-map.md)                                | Fleet Map — CSS Grid                                                    | Accepted |
| [005](005-state-persistence.md)                        | State Persistence — In-Memory + JSON Snapshots                          | Accepted |
| [006](006-openclaw-reuse.md)                           | OpenClaw Reuse — Copy + Adapt (Not Plugin/Dependency)                   | Accepted |
| [007](007-project-structure.md)                        | Project Structure — Yarn Workspaces Monorepo                            | Accepted |
| [008](008-remote-communication.md)                     | Remote Communication — Node Agent (Inbound WS)                          | Accepted |
| [009](009-slot-workspace.md)                           | Slot Workspace — Read-Only IDE View via FS/Git RPC                      | Accepted |
| [010](010-slot-view-layout.md)                         | Slot View Layout — Unified IDE-Like Interface                           | Accepted |
| [011](011-structured-task-tracking.md)                 | Structured Task Tracking — Markdown-First Derived Schema                | Accepted |
| [012](012-device-screen-streaming.md)                  | Device Screen Streaming — H.264 via scrcpy/ScreenCaptureKit + WebCodecs | Accepted |
| [013](013-gateway-mediated-orchestration.md)           | Gateway-Mediated Orchestration — Run State Machine                      | Accepted |
| [014](014-llm-provider-abstraction.md)                 | LLM Provider Abstraction — pi-ai Multi-Provider                         | Accepted |
| [015](015-resource-streams.md)                         | Resource Streams — Project-Driven Multi-Stream Model                    | Accepted |
| [016](016-d9-copilot.md)                               | D9 Co-Pilot — Fleet Observer + Conversational Interface                 | Accepted |
| [017](017-llm-task-summaries.md)                       | LLM Task Summaries & Smart Branch Naming                                | Accepted |
| [018](018-dev-flow-interactive-autonomous.md)          | Dev Flow & Interactive/Autonomous Modes                                 | Accepted |
| [019](019-recipe-graph-visualization.md)               | Recipe Graph Visualization                                              | Accepted |
| [020](020-agent-to-node-rename.md)                     | Terminology Rename — Agent → Node                                       | Accepted |
| [021](021-llm-enhanced-orchestration.md)               | LLM-Enhanced Orchestration                                              | Accepted |
| [022](022-slot-lifecycle-simplification.md)            | Slot Lifecycle Simplification — 5-State Machine                         | Accepted |
| [023](023-runner-agnostic-tui-execution.md)            | Runner-Agnostic TUI-First Execution                                     | Accepted |
| [024](024-run-lanes-and-run-family-model.md)           | Run Lanes and Run-Family Model                                          | Accepted |
| [025](025-run-family-observability.md)                 | Run Family Observability                                                | Accepted |
| [026](026-self-improvement-recursive-loop.md)          | Self-Improvement Recursive Loop                                         | Proposed |
| [027](027-unified-gateway-state.md)                    | Unified Gateway State                                                   | Accepted |
| [028](028-pr-dashboard-github-quota.md)                | PR Dashboard GitHub Quota Strategy                                      | Accepted |
| [029](029-production-logging-intelligence-evidence.md) | Production Logging and Intelligence Evidence Registry                   | Accepted |
| [030](030-replay-provenance-and-reference-evals.md)    | Evaluation Packages and Reference Evals on Run Families                 | Accepted |
| [031](031-deterministic-first-auto-recovery.md)        | Deterministic-First Auto-Recovery                                       | Accepted |
| [032](032-runner-observability-via-hooks.md)           | Event-Driven Runner Observability via Hooks and Signal Files            | Accepted |
| [033](033-mobile-tmux-worker-control.md)               | Mobile Control of General Tmux Workers                                  | Accepted |
| [034](034-recipe-protocol-v1.md)                       | Recipe Protocol v1                                                      | Proposed |
| [035](035-node-support-bundles.md)                     | Node Support Bundles                                                    | Accepted |
| [036](036-cli-gateway-profiles.md)                     | CLI Gateway Profiles and Auth                                           | Accepted |
| [037](037-prepare-profiles.md)                         | Prepare Profiles — Project-Defined Slot Entry Points                    | Accepted |
