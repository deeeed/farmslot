# Worker: Review-PR — #{{PR_NUMBER}}

> **Signal file:** `./mark N` for progress; `SIGNAL.json` only when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete --outcome success` (never `echo > SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

You are reviewing a **farmslot** PR (Command Center + gateway + optional Companion). Work autonomously — if blocked, set `STATUS: blocked` with reason and stop.

## Task

```text
PR_NUMBER: {{PR_NUMBER}}
PR_TITLE: {{PR_TITLE}}
PR_BRANCH: {{PR_BRANCH}}
PR_URL: {{PR_URL}}
REVIEW_TIER: {{REVIEW_TIER}}
RECIPE_STRATEGY: {{RECIPE_STRATEGY}}
TASK_DIR: {{TASK_DIR}}
SESSION: {{SESSION}}
REPO: {{REPO}}
PLATFORM: {{PLATFORM}}
CDP_PORT: {{CDP_PORT}}
WATCHER_PORT: {{WATCHER_PORT}}
RUNTIME_DIR: {{RUNTIME_DIR}}
SLOT: {{SLOT}}
STATUS: pending
```

## PR Body

{{PR_BODY}}

## Linked Tickets

{{LINKED_TICKETS}}

## Linked Ticket Descriptions

{{LINKED_DESCRIPTIONS}}

## Acceptance Criteria (numbered — reference by number throughout)

{{ACCEPTANCE_CRITERIA}}

If empty or `_Not specified_`, **do not invent ACs**:

1. Flag PR hygiene: no linked issue — review evaluates PR-author claims only.
2. Extract **verbatim** claims from Summary / Validation / Screenshots sections. Label `## Review Claims` (not Acceptance Criteria).

---

## Quality contracts (read before checklist)

After fixture sync, read:

- `{{recipe_quality_path}}` — recipe authoring + PR evidence package
- `{{review_quality_path}}` — reviewer rubric, evidence audit, farmslot antipatterns
- `CLAUDE.md` (root) + `apps/command-center/CLAUDE.md`

Apply **fs-recipe-quality** when auditing recipes or evidence (`.agents/skills/fs-recipe-quality/SKILL.md`).

## Tier reference

| Step group | light | standard | full |
|------------|-------|----------|------|
| Parse PR + read files | yes | yes | yes |
| Doctor + CDP | skip | check | full gate |
| Evidence audit (read PNGs) | PR embeds only | yes | yes + re-run recipe if weak |
| Recipe coverage matrix | skip | if recipe present | required |
| Typecheck + gateway tests | yes | yes | yes |
| Live recipe re-validation | skip | UI PRs w/ CDP up | required for UI PRs |
| Domain antipatterns | light | yes | full checklist |

`RECIPE_STRATEGY` when set: `full-qa` = proof per visual AC; `smoke` = typecheck/tests only; `targeted` = tests + screenshots for touched UI only.

---

## Checklist

**STOP GATE:** Mark step N `[x]` before starting step N+1. Sequential only.

### Setup (1–5)

- [ ] **1. Read quality docs** — `{{recipe_quality_path}}`, `{{review_quality_path}}`, both CLAUDE files.
- [ ] **2. Update status** — `STATUS: working`, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Print tier** — `Review tier: {{REVIEW_TIER}}`.
- [ ] **4. Doctor + CDP** [standard+full]:
  ```bash
  cd {{REPO}}
  node apps/command-center/scripts/agentic/recipe-doctor.mjs \
    --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --slot-id {{SLOT}} --json
  bash apps/command-center/scripts/debug-chrome.sh
  bash projects/farmslot/setup/capture-helper-tmux-check.sh || true
  ```
  **full:** doctor fail → `STATUS: blocked`, stop. **standard:** CDP down → note `code review only`, continue.
- [ ] **5. Fetch PR metadata + diff:**
  ```bash
  gh pr diff {{PR_NUMBER}} --repo {{GH_REPO}} > /tmp/pr-{{PR_NUMBER}}.diff
  gh pr view {{PR_NUMBER}} --repo {{GH_REPO}} --json title,body,headRefName,changedFiles,labels,reviews
  ```

### Parse PR (6–9)

- [ ] **6. Classify changed files** — CC UI (`apps/command-center/ui`), gateway (`services/gateway`), protocol (`packages/protocol`), companion (`apps/companion`), scripts, docs-only.
- [ ] **7. Read every changed file in full** — not diff hunks alone.
- [ ] **8. Enumerate ACs** — verbatim quotes under `## Recipe ACs` or `## Review Claims` at bottom of this TASK file. Add `Source:` line.
- [ ] **9. Prior reviews** — list `CHANGES_REQUESTED` reviews; note commits since each; avoid duplicating addressed feedback.

### Evidence audit (10–12) [standard+full for UI PRs]

**Silent skips = task failure.** Every AC ends PROVEN or UNTESTABLE with rationale.

- [ ] **10. Collect evidence artifacts** — from PR body URLs, `{{TASK_DIR}}/inputs/inherited/`, or PR author's task artifacts if materialized. List every PNG/MP4 path or URL.
- [ ] **11. Read every screenshot** — Read tool on each PNG. Build per-AC matrix (see `review-quality.md`). Verify hosted URLs return HTTP 200 when used in PR body.
- [ ] **12. fs-recipe-quality pass** — when `recipe.json` exists in PR body, inherited inputs, or author artifacts:
  - Critique recipe graph + evidence fit
  - Write `{{TASK_DIR}}/artifacts/recipe-coverage.md`
  - Write `{{TASK_DIR}}/artifacts/recipe-quality.json` if you repair/generate review recipe
  - **light:** skip 12 if no recipe; note in report

### Live validation (13–16) [standard+full]

- [ ] **13. Confirm branch** — `git branch --show-current` matches `{{PR_BRANCH}}`.
- [ ] **14. Typecheck + gateway tests:**
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **15. Re-run author recipe** [full + UI PR + CDP up] — when PR includes validation recipe or `artifacts/recipe.json` in inherited context:
  ```bash
  cd {{REPO}}
  bash {{recipe_validate_wrapper}} \
    --recipe <path-to-recipe.json> \
    --artifacts-dir {{TASK_DIR}}/artifacts/review-recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}} \
    --slow 2000 \
    --record-video=full-run
  ```
  Re-read review-run screenshots; update coverage matrix.
- [ ] **16. Companion PRs** — when diff touches `apps/companion`, note platform (ios/android) and whether device proof is present or UNTESTABLE.

### Static + domain review (17–20)

- [ ] **17. Farmslot antipatterns** — scan diff against `{{review_quality_path}}` table (swallowed exceptions, UI injection, protocol duplication, script hardcoding).
- [ ] **18. Fix quality** [standard+full] — minimal correct fix? tests assert right behavior? brittle mocks/import-time constants?
- [ ] **19. Validate concerns before flagging** [standard+full] — trace code paths; use CDP/gateway when claim is runtime-visible. No speculative noise.
- [ ] **20. Publication hygiene** — broken screenshot URLs, local paths in PR body, missing `evidence-manifest.json` when visual ACs claimed.

### Report (21–22)

- [ ] **21. Write `{{TASK_DIR}}/artifacts/review.md`** — use report contract in `{{review_quality_path}}`. Include Recipe Coverage matrix, Evidence Audit, Recommended Action. Coverage &lt; 100% without UNTESTABLE rationale → `REQUEST_CHANGES` or explicit escalation.
- [ ] **22. Write `{{TASK_DIR}}/artifacts/line-comments.json`** — inline findings with severities; empty array if none.

### Finish (23)

- [ ] **23. Done** — `STATUS: done`, then `{{TASK_DIR}}/mark complete --outcome success --mark-last`. **Read-only** — no commits, no pushes.

## Rules

- Never mention AI/LLM in review content.
- Never inject UI state to “verify” author claims.
- Prefer `yarn typecheck` — no emitting builds into source trees.
- Independent review required before merge per repo policy.