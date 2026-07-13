# ADR-017: LLM-Generated Task Summaries & Smart Branch Naming

**Status**: Accepted
**Date**: 2026-04-01

## Context

The Runs UI shows only opaque ticket refs (e.g., "PROJ-2686") with no description of what the task is about. Branch names like `fix/proj-2686` are equally uninformative. With 14+ active runs, it's impossible to quickly tell which run is tackling which domain area.

The gateway already fetches ticket data (Jira/GitHub) during the GRADE and WRITE_TASK steps. We have the content — we just don't surface a human-readable summary.

## Decision

### 1-line LLM summary at dispatch time

At the GRADE step (fix-bug flows) or WRITE_TASK step (feature/PR flows), generate a ~60-char summary and a kebab-case branch slug using Haiku. Store the summary on `Run.summary` and embed the slug into the branch name.

### Flow-specific behavior

- **fix-bug**: Haiku generates summary + slug from ticket title, description, affectedArea, and labels
- **feature**: Same as fix-bug (ticket data available after fetch)
- **review-pr / pr-complete**: Use PR title directly as summary — no LLM call needed
- **update-branch**: Inherit summary from parent run or skip

### Branch naming

Combined branch: `{flowDir}/{ticketSlug}-{branchSlug}` (e.g., `fix/proj-2686-fix-send-button-crash`). Total slug capped at 50 chars.

### Failure mode

Non-fatal. If LLM call fails or JSON parsing fails:

- Summary falls back to `ticket.title.slice(0, 60)`
- Branch slug falls back to bare ticket slug (existing behavior)
- Run proceeds normally

## Consequences

- Every run gets a scannable 1-line description in the UI
- Branch names carry semantic meaning for reviewers
- Minimal cost: one Haiku call per bug/feature dispatch (~0.001 USD)
- Backward compatible: existing runs have `summary: undefined`, UI renders conditionally

## Relates To

- ADR-011 (structured task tracking) — summary enriches run metadata
- ADR-014 (LLM provider abstraction) — uses `callLLM()` with Haiku model
