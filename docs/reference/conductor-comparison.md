# Conductor vs Farmslot Product Comparison

Status: supporting deep-dive  
Last reviewed: 2026-05-11

## Purpose

This document compares Farmslot with Conductor by Melty Labs (`conductor.build`) at the product-feature level. It exists to make the chat analysis durable without changing canonical Farmslot product scope.

Use the canonical Farmslot product docs for product authority:

- [PRD-product.md](../PRD-product.md)
- [PRD-core-farmslot-canonical.md](../PRD-core-farmslot-canonical.md)
- [PRD-command-center-canonical.md](../PRD-command-center-canonical.md)
- [PRD-automation-intelligence-canonical.md](../PRD-automation-intelligence-canonical.md)
- [PRD-mobile-companion-canonical.md](../PRD-mobile-companion-canonical.md)
- [PRD-runner-execution-canonical.md](../PRD-runner-execution-canonical.md)

## Source Notes

Conductor sources reviewed:

- Conductor docs entry point: <https://www.conductor.build/docs>
- Workspace model: <https://www.conductor.build/docs/concepts/workspaces-and-branches>
- Workflow: <https://www.conductor.build/docs/concepts/workflow>
- Parallel agents: <https://www.conductor.build/docs/concepts/parallel-agents>
- Agent modes: <https://www.conductor.build/docs/concepts/agent-modes>
- Testing: <https://www.conductor.build/docs/concepts/testing>
- Issue to PR: <https://www.conductor.build/docs/guides/issue-to-pr>
- Review and merge: <https://www.conductor.build/docs/guides/review-and-merge>
- Diff viewer: <https://www.conductor.build/docs/reference/diff-viewer>
- Checks: <https://www.conductor.build/docs/reference/checks>
- `conductor.json`: <https://www.conductor.build/docs/reference/conductor-json>
- Big Terminal Mode: <https://www.conductor.build/docs/reference/big-terminal-mode>
- Checkpoints: <https://www.conductor.build/docs/reference/checkpoints>
- MCP: <https://www.conductor.build/docs/reference/mcp>
- Security and permissions: <https://www.conductor.build/docs/reference/security-and-permissions>
- Privacy: <https://www.conductor.build/docs/reference/privacy>

Farmslot sources reviewed:

- [README.md](../../README.md)
- [DOCS-GOVERNANCE.md](../DOCS-GOVERNANCE.md)
- [PRD-product.md](../PRD-product.md)
- [PRD-core-farmslot-canonical.md](../PRD-core-farmslot-canonical.md)
- [PRD-command-center-canonical.md](../PRD-command-center-canonical.md)
- [PRD-automation-intelligence-canonical.md](../PRD-automation-intelligence-canonical.md)
- [PRD-mobile-companion-canonical.md](../PRD-mobile-companion-canonical.md)
- [PRD-runner-execution-canonical.md](../PRD-runner-execution-canonical.md)
- [IMPLEMENTED-HISTORY.md](../IMPLEMENTED-HISTORY.md)
- [ADR-024: Run Lanes and Run-Family Model](../adr/024-run-lanes-and-run-family-model.md)

Implementation evidence was also checked in `packages/*`, `apps/command-center/ui/src/*`, and `scripts/*`.

## Executive Summary

Conductor and Farmslot overlap most strongly at the "run coding agents in isolated workspaces, review diffs, and merge PRs" layer.

The difference is product center of gravity:

- **Conductor** is a polished macOS local workspace and PR orchestration product. Its main abstraction is a git-backed workspace with an agent chat, run scripts, diff review, checks, PR flow, and optional terminal mode.
- **Farmslot** is a supervised agent-run operations system. Its main abstraction is a persistent run on a slot in a fleet, with lifecycle state, health, artifacts, decisions, recipes, device evidence, run families, comparison lanes, and eval/fine-tuning surfaces.

The simplest framing:

- Conductor: "Give each task an isolated workspace, run agents, review changes, merge."
- Farmslot: "Operate, monitor, validate, compare, and improve autonomous coding-agent runs across machines, devices, evidence, and follow-up workflows."

## Feature Matrix

| Product area             | Conductor                                                                                                                      | Farmslot                                                                                                                                    | Comparative read                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Core abstraction         | Project -> repository -> workspace -> branch -> working tree -> running environment.                                           | Machine pool -> slot -> repo/runtime/resources -> run -> task/artifacts.                                                                    | Similar category, different depth. Conductor starts from code workspaces; Farmslot starts from operational capacity and run state. |
| Isolation                | One git-backed workspace per task/issue/experiment/PR. Workspace isolation is development isolation, not a security boundary.  | Slot isolation includes repo checkout, branch, tmux session, device/runtime resources, task dir, artifact dir, health state, and lifecycle. | Farmslot isolates more operational state. Conductor likely has simpler onboarding.                                                 |
| Parallel agents          | Multiple workspaces for independently shippable work; multiple agents in one workspace for shared branch/code state.           | Multiple slots/runs across local and remote machines; production/validation/comparison lanes; sibling variants for side-by-side evaluation. | Farmslot has a more explicit comparison/eval model.                                                                                |
| Agent support            | Claude Code and Codex first-class; Big Terminal Mode presets include Claude, Codex, OpenCode, Amp, Pi, Copilot, Gemini.        | Runner-neutral TUI-first contract across Claude, Codex, OpenCode, and future runners; safety tiers and capability modeling.                 | Conductor is more packaged for everyday agent launch; Farmslot is more explicit about runner semantics.                            |
| Agent modes              | Plan Mode, Fast Mode, reasoning controls, checkpoints, skills; Codex personalities.                                            | Flow types, run modes, safety tiers, task templates, agent roles, runner capabilities.                                                      | Conductor exposes user-friendly session controls. Farmslot exposes workflow/runtime controls.                                      |
| Setup and config         | `conductor.json`, repository settings, setup/run/archive scripts, files-to-copy, `CONDUCTOR_PORT`.                             | `pool/*.json`, `project.json`, hooks, fixtures, resources, health checks, slot actions.                                                     | Conductor is lighter and more team-shareable. Farmslot is more expressive for specialized environments.                            |
| Run scripts/testing      | Run button, terminal commands, Spotlight testing for root-sync cases, one-service automation caveat in docs.                   | Project hooks, gateway lifecycle steps, recipe reruns, evidence manifests, device/CDP validation, scripted slot checks.                     | Farmslot has stronger validation/evidence machinery; Conductor is simpler for normal web app loops.                                |
| Diff/review              | Diff Viewer, local comments, GitHub review comments, unified diff, commit filtering, Review action.                            | PR dashboard, review comments, branch diffs, review gates, ready gates, local PR packages, review-depth provenance.                         | Conductor likely wins polish for manual review UX. Farmslot wins auditability and gate depth.                                      |
| PR/checks                | Checks tab covers git status, PR metadata, CI/status checks, deployments, comments, todos; PR creation and merge/archive flow. | PR status/list/monitor, CI monitor, bot comment triage, PR dashboard, PR completion/follow-up runs.                                         | Both cover PR readiness. Farmslot models follow-up automation more deeply.                                                         |
| Checkpoints              | First-class local private-git-ref checkpoints with turn-level revert.                                                          | No equivalent polished user-facing checkpoint feature found in this pass.                                                                   | Conductor advantage.                                                                                                               |
| Todos/decisions          | Todos are merge-readiness blockers; `@todos` can attach them to prompts.                                                       | Persistent decisions, violations, review gates, run steps, queue items, monitor nudges.                                                     | Similar operator need, different model. Farmslot is more state-machine oriented.                                                   |
| Terminal                 | Big Terminal Mode restores sessions and can run arbitrary terminal tools/agents.                                               | Tmux/PTY streaming, polling fallback, role/context-scoped terminals, node daemon, terminal input/nudge routing.                             | Farmslot has stronger remote/multi-slot terminal operations.                                                                       |
| Workspace editing        | Conductor supports opening workspaces in IDEs and reviewing diffs.                                                             | Slot workspace includes file tree, read/write/rename/delete, git status/diff/log/show, stage/unstage/discard, search.                       | Farmslot has an in-product mini-IDE surface; Conductor leans on app + IDE integration.                                             |
| Devices/screen           | Not a major public-doc concept.                                                                                                | Device grid, simulator/emulator health, screen streaming, capture evidence, CDP/device validation workflows.                                | Farmslot advantage.                                                                                                                |
| Persistent orchestration | Public docs center on workspace/session workflow and app state.                                                                | Gateway-owned run lifecycle, run store, monitor state, queueing, webhooks, decisions, recovery, completion pipeline.                        | Farmslot advantage.                                                                                                                |
| Run history/families     | Workspaces can be archived/restored with chat history.                                                                         | Run family identity, parent/child follow-ups, inherited artifacts, comparison variants, family observability.                               | Farmslot advantage for long-running supervised automation.                                                                         |
| Evals/comparison         | Multiple workspaces can compare approaches before choosing one.                                                                | Comparison lane, variants, eval experiments, result packages, artifact-only completion, fine-tuning exports.                                | Farmslot has a productized eval direction.                                                                                         |
| Mobile                   | No native mobile oversight surface found in public docs.                                                                       | Native mobile companion is a documented product chunk with shipped milestones and artifact work in progress.                                | Farmslot advantage.                                                                                                                |
| Cloud/enterprise         | Cloud early access and Enterprise pages; managed settings and enterprise data privacy mode.                                    | Local/operator-oriented product in this repo; no equivalent commercial packaging surfaced in this pass.                                     | Conductor advantage for commercial packaging.                                                                                      |
| Security/privacy         | Mac app, local workspaces/chats, model-provider traffic, local user permissions, approvals, enterprise privacy toggle.         | Local/remote slot execution with project/pool config and explicit safety tiers; operationally powerful and not security-boundary-first.     | Both are local-permission tools. Conductor's privacy story is more productized.                                                    |
| Open source              | No verified public official source repo for Conductor.build found.                                                             | Farmslot is this repo.                                                                                                                      | `conductor-oss/conductor` is a different Netflix/Orkes workflow engine, not Melty Labs Conductor.                                  |

## Farmslot Implementation Maturity Notes

Static inspection and verification found the following:

- Command Center has top-level routes for fleet, terminal, devices, dispatch, PRs, decisions, violations, runs, evals, finetune, and config in `apps/command-center/ui/src/components/app-shell.ts`.
- Protocol declares broad RPC methods for fleet, slot lifecycle, dispatch, terminal, PR, config, filesystem, git, resources, runs, evals, LLM auth/config, chat, node health, screen thumbnails, and recipes in `packages/protocol/src/methods.ts`.
- Gateway wires major method groups in `services/gateway/src/server.ts`.
- Run orchestration is implemented through `run.create`, run list/get/cancel/pause/resume/replay/grade/delete/archive/cleanup/backfill in `services/gateway/src/methods/run.ts`.
- Slot lifecycle is implemented in `services/gateway/src/methods/slot.ts`, including prepare/release/recycle and prepare-lock hardening.
- Terminal/tmux is implemented through terminal methods, tmux methods, `pty-stream`, `tmux-stream`, and node-agent support.
- PR/CI is implemented through `services/gateway/src/methods/pr.ts` and CI monitor code.
- Recipes and recipe rerun/cancel/command paths are implemented in `services/gateway/src/methods/recipe.ts`.
- Evals and finetune surfaces are implemented but newer/emerging.
- Chat/operator Co-Pilot exists through gateway chat methods and UI chat panel.

Fresh verification from the comparison pass:

- `cd apps/command-center && yarn typecheck` passed.
- `70` non-`node_modules` test/spec files were found under `command-center`.
- Key protocol/server anchors were confirmed for `fleet.status`, `slot.prepare`, `terminal.subscribe`, `pr.status`, `run.create`, `eval.experiment.create`, `family.observability.get`, and `chat.send`.

Known caveats:

- Some protocol methods appear ahead of public gateway wiring, especially screen subscribe/unsubscribe naming versus stream subscribe/unsubscribe.
- Static inspection cannot prove every UI route renders correctly against live data.
- Many Farmslot features depend on local external state: GitHub, Jira, tmux sessions, node daemons, pool/project JSON, devices, and `.farm-status.json`.
- Test coverage is broad, but the root command-center package exposes typecheck/build/dev scripts rather than one obvious consolidated test command.

## Open Source Note

No official public GitHub repository for Conductor by Melty Labs was verified in this pass.

Important distinction:

- `github.com/conductor-oss/conductor` is the Netflix/Orkes workflow engine. It is not the Melty Labs Conductor Mac app.
- Melty Labs has a public older project at <https://github.com/meltylabs/melty>, but that is not the current Conductor app.

## Strategic Implications

Conductor is the clearer benchmark for product polish:

- first-run onboarding
- low-friction workspace creation
- approachable session controls
- polished diff/check/PR loop
- checkpoint/revert UX
- privacy/commercial positioning

Farmslot's defensible depth is elsewhere:

- remote/local fleet operations
- slot lifecycle and health
- persistent gateway-owned runs
- monitor nudges and decisions
- device/screen/evidence workflows
- recipe/rerun/proof loops
- run families and follow-up inheritance
- comparison lanes and eval package direction
- mobile operator oversight

The risk is not that Farmslot duplicates Conductor. The risk is that Farmslot's stronger capabilities are harder to understand because they are packaged as operational machinery rather than a simple workspace product. If Farmslot needs a clearer product story, the comparison suggests emphasizing:

1. **"Conductor for one Mac workspace workflow; Farmslot for supervised run operations."**
2. **"Not just parallel coding agents: persistent, evidence-backed run families."**
3. **"Built for device-heavy, PR-heavy, validation-heavy teams where runs need history and proof."**

## Follow-Up Questions

- Should Farmslot add a first-class "workspace" vocabulary for the parts that overlap with Conductor, or keep "slot/run" as the primary model?
- Should Command Center prioritize a Conductor-like onboarding/demo path that shows a single happy path before exposing fleet depth?
- Should Farmslot add a checkpoint/revert story, or leave that to Git/runner-native tooling?
- Should the public product story lead with fleet/device/evidence/evals instead of generic parallel agents?
