# ADR-023: Runner-Agnostic TUI-First Execution

**Status:** Accepted
**Date:** 2026-04-12, accepted 2026-04-20
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-014](014-llm-provider-abstraction.md), [ADR-018](018-dev-flow-interactive-autonomous.md), [ROADMAP](../ROADMAP.md)

## Context

Farmslot originally grew around Claude Code sessions running inside tmux panes. That architecture has a real operator advantage:

- the worker is always visible in tmux
- humans can attach mid-run
- the gateway can capture output, detect stalls, and send nudges
- a slot feels like a live operator surface, not a black-box job

As Codex and future runners (for example OpenCode or Cursor-adjacent flows) enter the system, the current implementation shows three problems:

1. **Runner behavior is encoded ad hoc.** Large parts of the gateway assume `codex` is the only non-Claude runner, and many places still effectively treat “not codex” as Claude.
2. **Execution mode is underspecified.** A runner can have a TUI mode and a non-interactive exec mode, but Farmslot has not modeled that explicitly.
3. **Recovery/rules artifacts are Claude-shaped.** `CLAUDE.local.md` works today, but other ecosystems expect different file layouts (`.cursor/rules/...`, `.agents/skills/...`).

This is not just a Command Center concern. It affects the core Farmslot product: pool config, dispatch semantics, monitoring, tmux orchestration, task templates, and operator expectations.

## Decision

Adopt a **runner-agnostic, TUI-first execution model**.

### 1. All runners default to TUI mode

Farmslot prefers TUI-mode launch for every runner: visible in tmux, attachable, monitorable by the gateway, and interruptible. When a runner's CLI does not expose a viable operator-attachable interactive session today, exec mode is tolerated as a pragmatic exception — not a design preference. Codex is the canonical example: it ships in exec mode because the Codex CLI does not yet offer an interactive TUI surface. When a runner gains a usable TUI, its `defaultLaunchMode` flips without breaking the architectural contract.

### 2. Runner abstraction is capability-based

**Implemented.**

Runner handling is modeled by capabilities instead of hardcoded special cases. The `RunnerDefinition` interface exposes: `defaultLaunchMode`, `supportsInteractivePrompt`, `supportsTmuxNudges`, `continueCommand`, `persistsSessionFiles`, `sessionReload`, `retainedSessionHandoff`, `requiresBusyComposerPoll`, `flagsByTier`, and other capability flags. The single entry point `buildLaunchCommand()` in `runners.ts` consumes these flags and produces the appropriate launch invocation for any runner, eliminating ad hoc runner-specific branches.

Capability ownership is an invariant, not a preference:

- workflow and client code provide policy, task, and session context; they do not branch on runner IDs
- runner-specific command syntax and delivery mechanics live only in the shared runner adapter
- structured hooks and native persisted-session APIs take precedence over terminal text
- TUI parsing is limited to runners explicitly declared `pane-only`; an absent structured capability fails closed or is reported unsupported
- a runner bug is fixed at this boundary and tested there so every workflow/client receives the same behavior

### 3. Safety is a separate dimension from runner choice

**Implemented.**

Runner selection and safety mode are different concerns. Farmslot now ships `SafetyTier` as a first-class property on `Run`, with three explicit tiers: `'sandboxed'`, `'full-auto'`, and `'dangerous'`. The source of truth for a run's safety tier follows resolution order: explicit `safetyTier` parameter at dispatch > parent run tier (for chained/relaunch flows) > project config (`project.json.default_safety_tier`) > runner intrinsic default (via `runnerDefaultSafetyTier()`). Every runner intrinsically defaults to `'sandboxed'`; projects that want the pre-refactor bypass posture opt in by setting `default_safety_tier` in their `project.json`. Runs created before the runner is resolved (e.g. when FIND_SLOT resolves runner via slot selection) leave `safetyTier` unset at create time and have it promoted once the runner is known, so Claude's default never leaks onto Codex runs. The UI badges the chosen tier on run-list display.

Pool `dispatch_cmd` templates opt in to tier-driven flags via the `{safety_flags}` placeholder; templates without the placeholder continue to work unchanged but do not honor runtime tier overrides.

### 4. Recovery instructions get one canonical source plus shims

**Deferred.**

Farmslot should not replace working Claude templates abruptly. The `.claude/CLAUDE.local.md` model continues to work. The rules-shim layer (emitting compatibility artifacts like `.cursor/rules/<name>/RULE.md` and `.agents/skills/<name>/SKILL.md`) is deferred until a second non-Claude runner reaches production use. At that point, the canonical runner-neutral recovery/rules model will be formalized and shim generation will be implemented.

### 5. Command Center is a consumer, not the owner

**Implemented.**

Command Center visualizes the runner-capability model (capability flags, launch modes, safety tiers) and consumes the shared runner registry, but the architectural ownership remains Farmslot-wide. The product roadmap and ADR set define runner execution semantics; Command Center roadmap items reference and depend on those decisions.

## Alternatives Considered

### A. Keep Claude as the special case and bolt on Codex/OpenCode individually

**Rejected.**

This preserves current velocity in the short term but guarantees long-term drift:

- repeated `if runner === 'codex'` branches
- template sprawl
- inconsistent monitoring and nudge behavior
- unclear operator expectations

### B. Prefer non-interactive exec mode for new runners

**Rejected as the default.**

Exec mode reduces some approval friction, but it weakens Farmslot's main operator advantage:

- less attachable
- less steerable
- weaker live intervention story
- encourages black-box execution instead of tmux-native observability

Exec mode can still exist later as an explicit option.

### C. Replace `CLAUDE.local.md` immediately with a new neutral artifact

**Rejected.**

Too risky while Claude-based templates and working flows are already in production use. Migration should preserve backward compatibility first, then converge the canonical abstraction.

## Consequences

**Positive:**

- Preserves Farmslot's strongest architectural property: visible, operator-friendly live sessions
- Gives all runners one architectural home
- Makes future runner addition cheaper and less brittle
- Separates runner choice from safety choice
- Enables compatibility with Cursor/OpenCode-style rule surfaces without breaking Claude-first setups

**Negative:**

- More explicit modeling is required in gateway, scripts, pool config, and docs
- Some runners may not support tmux nudging/resume as richly as Claude; the capability model must expose that honestly
- Product/docs complexity increases because launch mode and safety mode become first-class concepts

**Risks:**

- A runner may claim TUI mode but still surface trust/approval UX that breaks unattended operation
- Over-generalization could obscure useful runner-specific quirks if capability definitions are too weak
- Recovery shim sprawl could become messy unless the canonical source remains clearly owned

## Initial Implementation Guidance

1. Make runner definitions explicit and capability-based.
2. Keep TUI launch as the default path for every runner.
3. Introduce safety tiers separately from runner identity.
4. Keep `.claude/CLAUDE.local.md` working while emitting shims for other ecosystems.
5. Validate with real tickets on real slots before claiming parity.

## Validation Guidance

Use live-slot validation, not only unit tests.

At minimum:

- one real Claude TUI run
- one real Codex TUI run
- monitor/nudge behavior in tmux
- recovery-file presence and correctness
- slot lifecycle correctness through dispatch → monitor → completion

## Status Update — 2026-04-20

### Shipped Capabilities

Four duplicated launch blocks in gateway code have been collapsed into a single `buildLaunchCommand(vars, runner, model, prompt, opts)` entry point in `runners.ts`. This single source of truth accepts a `RunnerDefinition` and consumes its capability flags — `defaultLaunchMode`, `supportsInteractivePrompt`, `continueCommand`, `persistsSessionFiles`, `requiresBusyComposerPoll`, and `flagsByTier` — to produce the appropriate launch invocation for any runner without ad hoc branching.

`SafetyTier` (`'sandboxed'` / `'full-auto'` / `'dangerous'`) ships as a first-class field on `Run` objects. Dispatch resolution follows explicit param > parent run tier > runner default, enabling inheritance during chained (self-review, ci-monitor) and relaunch flows without silent escalation. The UI displays the tier as a badge on run-list display.

Codex exec-mode validation has been conducted on live slots; the exec-mode tolerance is documented in §1. Registered runners now declare their default safety tier via `runnerDefaultSafetyTier()`; the non-LLM built-ins are `none` and `scripted`.

### Deferred Work

Rules-shim layer (ADR-023 §4) remains deferred until a second non-Claude runner reaches production use. OpenCode bring-up (stub exists) awaits runner implementation upstream. Codex TUI mode awaits corresponding CLI changes upstream.

## Status Update — 2026-04-30

`sendRunnerInstructionSafely` gains a per-call `opts: { forceBusyPoll?: boolean }` parameter (default `false` — existing call sites unchanged). The original capability shipped with `requiresBusyComposerPoll` as a per-runner registry flag, which is correct for routine continue-style nudges where Claude's prompt is already idle (ci-monitor, self-review). The branch-affinity nudge flow (ADR-024 §7 addendum) needs to send a prompt into a Claude session that may be mid-tool-use; without polling for the busy-composer marker, the prompt is queued or eaten. `nudgeDispatch` passes `forceBusyPoll: true`. No new runner-registry flag — this is a per-call policy, not a per-runner capability.

## Amendment 1: agent harness vocabulary, 2026-11-02

**Status:** Proposed. Arthur approved the vocabulary on 2026-11-01. The rename ships as one PR after the stability runs land.

### Decision

**Glossary.** Every term has one meaning.

| Term          | Meaning                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Model         | The LLM a harness runs (`opus`, `grok-4.7`).                                                                                    |
| Agent harness | The CLI that runs a model with its tools: Claude Code, Codex, Grok CLI, Cursor, Pi, OpenCode. Bare "harness" always means this. |
| Transport     | How Farmslot talks to the harness: `tmux` or `native` ([ADR-057](057-structured-runner-transports.md)).                         |
| Worker        | An agent harness session doing a run's work.                                                                                    |
| Recipe runner | What executes a recipe (`@farmslot/recipe-runner`). The only remaining Farmslot use of "runner".                                |
| App harness   | The product layer that drives the app under test. `mm-harness` is "the MetaMask app harness"; its package name stays.           |

Until the rename lands, "runner" in this ADR, ADR-057 and the code means agent harness.

**Default transport.** tmux stays the default transport. Later the default becomes a configuration option, per person or per farm, shipped as tmux; a per-dispatch `--transport` keeps working. Recorded, not built.

**Terminals direction.** Once native is as good as tmux, the Terminals page in Command Center and Companion lists tmux sessions and native agent harness sessions together, as sessions. They differ only in interface: a terminal view or a conversation view. Recorded, not built.

**Rename plan.** One PR, with no aliases (the no-shims rule).

- Code: every `Runner*` identifier, `runner` field and `runner.*` RPC method (`runner.modelCatalog`, `runner.visibleModels.get` and `.set`) that means the agent harness becomes `Harness*`, `harness` and `harness.*`: protocol contracts, the gateway and agent-runtime registries and their `runners/` directories, slot-config and `schemas/project.schema.json`, the CLI, `@farmslot/review-dispatch`, `@farmslot/skills`, root `scripts/` (including `scripts/runner-validation/`), `.agents/skills`, the Companion agentic scripts, and the Command Center scripts and CSS (`--runner-accent`).
- CLI flags: `--runner` becomes `--harness`; `--runner-command`, and the cooking lane's `--runner-cmd`, `--runner-mode` and `--runner-log`, follow.
- Environment variables: every one whose `RUNNER` means the agent harness, including `FARMSLOT_RUNNER`, `FARMSLOT_VALIDATION_RUNNER`, `FARMSLOT_VALIDATION_RUNNER_BIN`, `FARMSLOT_SCENARIO_RUNNER`, the visual review, repair, capture-proof and review-test variables, `NATIVE_COMPANION_RUNNER`, and the operator-set `FARMSLOT_COPILOT_RUNNER`, `FARMSLOT_BACKLOG_REFINER_RUNNER` and `FARMSLOT_ROADMAP_REFINER_RUNNER`. A silent rename of the operator-set ones falls back to their default harness, so their old names fail with a message.
- Configuration outside this repo, changed in matching commits that land with the PR:
  - project.json keys in the project repos: `review.runner`, `defaults.<flow>.runner`, `workflow_defaults.review-pr.execution.models[].runner`, `roadmap.runner` and `roadmap.runner_command`;
  - the project templates and packs in those repos;
  - pool `dispatch_cmd` placeholders `{runner}` and `{runner_path}`, and the refinement template placeholder `{{runner}}`;
  - the observability hook commands installed into slot worktrees (`FARMSLOT_RUNNER=`), reinstalled.
- Persisted stores: every persisted file name or key that carries `runner` is migrated in place once, on the host that owns it, before strict decoding. That includes run records and run episodes (with a schema version bump), the backlog, dispatch queue and roadmap stores, slot status rows, PR rules and saved review defaults, review history, machine-parking journals (including the `runner-stopping`, `runner-stopped` and `runner-reloading` states), native profile registrations, native session journals on every node, the per-principal visible-model preferences (`runner-preferences/…/runner-visible-models.json`, `byRunner`) and task directories' `.runner-session.json`. Derived caches, such as the client history projection, are rebuilt instead.
- Apps: Command Center and Companion name the column and labels "Agent" and show harness · model · effort: "Claude Code · opus · high".
- Docs: docs and the docs site, ADR text, CLAUDE.md and AGENTS.md rules, and the `~/xreview` scripts.
- File and directory names: the PR decides whether `scripts/runner-validation/`, `scripts/install-runner-observability.mjs`, the ADR files and the runner docs are renamed. Renaming the scripts also changes `.github/workflows`, which is Arthur's call.
- Bare "harness": existing uses that mean the app harness or a test harness become "app harness", "mm-harness" or "validation suite". The PR decides the name of `artifacts/harness-provenance.json`, which is app harness provenance.
- Release: the PR adds a client protocol check (Companion sends no protocol version today, and the gateway only logs a node mismatch), so older Companion and node builds fail closed with an upgrade message. Nodes and the gateway update together, then Companion (OTA or TestFlight). `@farmslot/protocol`, agent-runtime, review-dispatch, skills and the CLI are cut together, and packages that pin protocol exactly (mm-harness) are repinned.

Unchanged: other meanings of "runner" outside Farmslot (GitHub Actions `runner.*`, the pool migration runner, the agent-device iOS runner, a test runner); `@farmslot/recipe-runner` and its uses (`farmslot recipe --require-runner-provenance`, `RECIPE_RUNNER_VERSION`, the project var `recipe_runner_resolve_cmd`, `METAMASK_RUNNER_PROTOCOL_ROOT` and `METAMASK_RUNNER_FARMSLOT_ROOT`, the handoff manifest's `runner` evidence producer, mm-harness runner provenance); the pool keys `<harness>_path`, already named by harness ID (`claude_path`, `grok_path`); and MetaMask/skills, which never calls the Farmslot CLI.

### Size

Case-insensitive whole-word "runner" or "runners", excluding tests, on main b41c998c. Packages and apps count `src/` only; scripts, skills and docs count the whole directory:

| Area                        | Uses  | Files |
| --------------------------- | ----- | ----- |
| Gateway                     | 3,283 | 261   |
| Root `scripts/`             | 2,303 | 308   |
| Docs (`docs/`)              | 1,783 | 203   |
| Command Center UI           | 1,079 | 133   |
| Protocol                    | 371   | 52    |
| Companion                   | 254   | 48    |
| Companion agentic scripts   | 234   | 35    |
| `.agents/skills`            | 223   | 12    |
| Docs site                   | 212   | 46    |
| `@farmslot/review-dispatch` | 151   | 10    |
| `@farmslot/skills`          | 112   | 13    |
| Agent runtime               | 108   | 20    |
| CLI (7 `--runner` flags)    | 107   | 16    |
| Slot config                 | 86    | 4     |
| Command Center scripts      | 66    | 18    |
| Node                        | 3     | 2     |

`@farmslot/recipe-runner` (47 uses in 20 files) keeps its name. Some counted uses are recipe runner uses that stay.

### Rationale

"Runner" named both the agent CLI and the recipe executor (`@farmslot/recipe-runner`). One word per concept stops that drift. "Agent harness" names what the CLI is, a harness around a model, and leaves "runner" to the one component that runs recipes.

### Consequences

- The rename is a breaking change for project.json, pool configuration, environment variables and the CLI, so its PR is a `!` change with a BREAKING CHANGE footer.
- Older Companion and node builds stop working until they update; the fail-closed message says so.
- Project repos and pools change in step with the farmslot PR.

## References

- Product roadmap Phase 7: [ROADMAP.md](../ROADMAP.md)
- Gateway orchestration: [ADR-013](013-gateway-mediated-orchestration.md)
- Intelligence/provider abstraction: [ADR-014](014-llm-provider-abstraction.md)
- Interactive vs autonomous run modes: [ADR-018](018-dev-flow-interactive-autonomous.md)
