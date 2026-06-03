# ADR-021: LLM-Enhanced Orchestration via Prompt Templates

**Status:** Accepted
**Date:** 2026-04-09
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md) (state machine stays), [ADR-014](014-llm-provider-abstraction.md) (pi-ai reuse)

## Context

The gateway pipeline has ~4,300 lines of deterministic orchestration code. Some of it encodes policy decisions (CI triage, nudge messages, PR comment formatting) that are project-specific and could be simpler as LLM-driven prompt templates.

Two LLM calls already exist in the pipeline:

- `gradeTicket()` in `intelligence.ts` — bug difficulty scoring
- `rewritePRBodyWithLLM()` in `run-completion.ts` — artifact URL replacement in PR bodies

Both follow the same pattern: single-shot call with a system prompt, structured output, hardcoded fallback on failure. The pattern works.

The deterministic pipeline is correct and battle-tested (ADR-013). The problem isn't correctness — it's rigidity. Adding project-specific formatting, tone, or policy requires code changes in the gateway. LLM calls with project-specific prompt templates would make these decision points configurable without code changes.

## Decision

Add targeted `callLLM()` calls at specific decision points in the pipeline. Each call is driven by a project-specific `.md` prompt template stored in `projects/<name>/templates/prompts/`. If the template doesn't exist or the LLM call fails, fall back to the existing hardcoded behavior.

### Architecture

```
projects/<name>/templates/prompts/<decision>.md    ← project-specific prompt
  ↓  (loaded + expanded by loadPromptTemplate)
services/gateway/src/core/prompt-templates.ts               ← template loader (~40 lines)
  ↓  ({{VAR}} expansion)
llm/index.ts:callLLM()                             ← single-shot call (ADR-014)
  ↓  (text result)
caller code                                        ← validate length, use or fallback
```

**Template loading**: `loadPromptTemplate(project, 'decision-name.md', vars)` reads the file, expands `{{VAR}}` placeholders (case-insensitive), and returns the expanded string. Returns `null` if the template doesn't exist — caller uses hardcoded fallback.

**Call pattern**: Single-shot sonnet/haiku calls via `callLLM()`. No sessions, no multi-turn. System prompt = expanded template, user prompt = minimal trigger.

**Fallback**: Every LLM-enhanced path MUST have a hardcoded fallback. The pipeline works identically without templates — they're an enhancement, not a requirement.

### Candidate Decision Points

| #   | Decision Point                 | Template             | Current Code                                                                                               | What Changes                                                                                                                                                                          |
| --- | ------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PR comment formatting**      | `pr-comment.md`      | `run-completion.ts:buildPRCommentHardcoded()` — string concatenation of metrics table + collapsible report | Template controls layout, tone, which fields appear, section ordering. Project-specific branding without code changes.                                                                |
| 2   | **Bug grading**                | `grade-ticket.md`    | `intelligence.ts:gradeTicket()` — `GRADE_SYSTEM` const with hardcoded difficulty scale and JSON schema     | Projects define their own difficulty criteria (e.g., Example App cares about cross-chain vs single-chain, audiolab cares about audio pipeline complexity). Same JSON output contract. |
| 3   | **Task summary + branch slug** | `task-summary.md`    | `intelligence.ts:generateSummary()` — `SUMMARY_SYSTEM` const with generic slug rules                       | Projects set domain-specific slug conventions (e.g., Example App prefix by affected area, audiolab prefix by audio engine).                                                           |
| 4   | **Nudge messages**             | `nudge-message.md`   | `run-monitor.ts:buildNudgeMessage()` — switch on violation type returns fixed strings                      | Template receives violation type + context (pane content, elapsed time, step). LLM generates context-aware nudge instead of generic "you appear stuck".                               |
| 5   | **PR body rewrite**            | `pr-body-rewrite.md` | `run-completion.ts:rewritePRBodyWithLLM()` — inline 15-line system prompt in code                          | Extract the existing inline prompt to a template. Already uses `callLLM()` — just needs template externalization. Easiest migration.                                                  |
| 6   | **PR title formatting**        | `pr-title.md`        | `run-completion.ts:updatePRTitle()` — deterministic `prefix(scope): lowercased title`                      | Template could apply project-specific conventions (e.g., include ticket ID, different prefix rules, title length limits). Low priority — deterministic is fine here.                  |

**Priority order:** #1 (implemented), #5 (implemented), #2 (implemented), #4 (most impact on worker quality), #3, #6.

### Constraints

- Templates are project-specific — stored in `projects/<name>/templates/prompts/`, not in the gateway
- No new dependencies — reuses `callLLM()` from ADR-014
- No multi-turn — every template call is a single request/response
- No blocking — if the LLM is slow or down, the hardcoded path runs instantly
- Output validation — callers check length bounds before accepting LLM output

## Consequences

**Positive:**

- Project-specific formatting without gateway code changes
- Template iteration is fast — edit a `.md` file, no rebuild needed
- Graceful degradation — pipeline works identically without templates
- Visible validation — PR comments appear on GitHub, easy to compare LLM vs hardcoded

**Negative:**

- Additional LLM cost per run (~0.001-0.01 per call for haiku/sonnet)
- Non-deterministic output — same input may produce slightly different formatting
- Template debugging requires checking both the template file and the expanded vars

**Deferred:**

- Full orchestrator LLM sessions (multi-turn reasoning about pipeline decisions)
- Only pursue these if targeted single-shot calls prove insufficient

### Self-Improvement Loop (added 2026-04-15)

The deferred "cross-run intelligence" item has been partially implemented as a **self-improving feedback loop**. Workers write `artifacts/learnings.md` at the end of each run. When Arthur accepts a retrospective decision, a dedicated LLM analyzes the learning against all project files and proposes concrete diffs.

**Flow:**

```
Worker writes learnings.md → retrospective decision created →
Arthur accepts → improvement-engine.ts fires (async) →
LLM reads learning + project files (templates, fixtures, scripts, config) →
Proposes diff as new 'improvement' decision in inbox →
Arthur chats with LLM to refine the diff →
Apply = file write + git stage + validation (typecheck)
```

**Key decisions:**

- **Trigger:** Real-time on retrospective accept (not batch). Fire-and-forget — doesn't block the retrospective resolution.
- **Scope:** LLM can propose changes to any project file (templates, fixtures, scripts, project.json) — not limited to templates.
- **Per-project prompt:** `projects/<name>/templates/prompts/improvement-system.md` controls LLM behavior per project. Falls back to a hardcoded default if absent.
- **Dedicated model:** `improvementModel` field in `LLMConfig` (defaults to `standard` tier). Separate from intelligence/copilot models.
- **Chat iteration:** Multi-turn conversation to refine proposals before applying. Uses `callLLMChat()` with per-decision session state (in-memory `Map<decisionId, PiMessage[]>`).
- **Decision visibility:** Improvement decisions attach to the source run as `RunDecision` objects. `decisionList` widened to include completed runs with unresolved decisions (48h window).
- **Human gate:** Arthur always reviews and explicitly applies. Never auto-apply, never auto-commit.

**Templates:** `improvement-system.md` — same `{{VAR}}` expansion as other prompt templates. Vars: `{{LEARNING}}`, `{{PROJECT_FILES}}`, `{{PROJECT_NAME}}`. Output: structured JSON with `rationale` and `proposedChanges[]`.

## Implementation

### Template loader

1. `services/gateway/src/core/prompt-templates.ts` — `loadPromptTemplate()` utility, exported from `core/index.ts`

### Gateway wiring

2. `run-completion.ts` — `buildPRComment()` tries template, falls back to `buildPRCommentHardcoded()`
3. `run-completion.ts` — `rewritePRBodyWithLLM()` tries template, falls back to inline prompt constants
4. `intelligence.ts` — `gradeTicket()` takes optional `project`, tries template, falls back to `GRADE_SYSTEM_FALLBACK`
5. `run-engine.ts` — passes `project` to `gradeTicket()`

### Project templates (extension)

6. `projects/example-browser-farm/templates/prompts/pr-comment.md`
7. `projects/example-browser-farm/templates/prompts/pr-body-rewrite.md`
8. `projects/example-browser-farm/templates/prompts/grade-ticket.md` — extension-specific criteria (Snaps, keyring, MV3)

### Project templates (mobile)

9. `projects/example-mobile-farm/templates/prompts/pr-comment.md`
10. `projects/example-mobile-farm/templates/prompts/pr-body-rewrite.md`
11. `projects/example-mobile-farm/templates/prompts/grade-ticket.md` — mobile-specific criteria (RN bridge, native modules, Detox)
