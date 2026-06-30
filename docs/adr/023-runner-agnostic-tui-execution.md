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

Runner handling is modeled by capabilities instead of hardcoded special cases. The `RunnerDefinition` interface exposes: `defaultLaunchMode`, `supportsInteractivePrompt`, `supportsTmuxNudges`, `continueCommand`, `persistsSessionFiles`, `requiresBusyComposerPoll`, `flagsByTier`, and other capability flags. The single entry point `buildLaunchCommand()` in `runners.ts` consumes these flags and produces the appropriate launch invocation for any runner, eliminating ad hoc runner-specific branches.

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

## References

- Product roadmap Phase 7: [ROADMAP.md](../ROADMAP.md)
- Gateway orchestration: [ADR-013](013-gateway-mediated-orchestration.md)
- Intelligence/provider abstraction: [ADR-014](014-llm-provider-abstraction.md)
- Interactive vs autonomous run modes: [ADR-018](018-dev-flow-interactive-autonomous.md)
