# Worker: Fix-Bug — {{TICKET_ID}}

> **Signal file:** `./mark N` for progress; `SIGNAL.json` only when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

## Task

```text
TICKET: {{TICKET_ID}}
TICKET_URL: {{TICKET_URL}}
TITLE: {{TICKET_TITLE}}
BRANCH: {{BRANCH}}
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

## Description

{{DESCRIPTION}}

## Acceptance Criteria

{{ACCEPTANCE_CRITERIA}}

## Checklist

### Early no-change exit (before code/PR mutations)

After `STATUS: working`, first decide if a code fix is still needed. If the bug is already fixed or cannot be reproduced in a valid target environment, do not create a fake commit/PR. Write `{{TASK_DIR}}/artifacts/no-change-report.md` and `{{TASK_DIR}}/artifacts/learnings.md` (investigation notes — or `- Nothing relevant — bug not reproducible/already fixed.`), then:

```bash
{{TASK_DIR}}/mark no-change --reason "<one sentence>"
```

Add `--already-fixed` when the bug is already fixed on the current branch. Use `{{TASK_DIR}}/mark blocked --reason "<one sentence>"` for branch/env/auth/device/CDP/precondition problems. Never call setup failure `not_reproducible`.

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Update status** — set `STATUS: working` in this file, then run `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Read the bug description** — understand the reported issue, affected area, and expected behavior.
- [ ] **4. Reproduce** — write `{{TASK_DIR}}/artifacts/recipe.json` from acceptance criteria using the required `$schema: "https://farmslot.io/schemas/recipe-v1.schema.json"`, `description`, and `workflow`, then run it against current code (must fail before the fix). Use state/command actions for backend and CLI bugs; browser actions are required only for visual claims. Omit the recipe only when no declared project action can exercise the bug, and record the exact limitation plus replacement deterministic reproduction. Read `{{recipe_quality_path}}` first.
  ```bash
  cd {{REPO}}
  # UI bugs only:
  bash apps/command-center/scripts/debug-chrome.sh
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run-repro \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}} || true
  cd apps/command-center && yarn typecheck
  ```
- [ ] **5. Locate the root cause** — identify the exact file(s) and line(s) causing the issue.
- [ ] **6. Create branch** — `git checkout -b {{BRANCH}}`
- [ ] **7. Implement the fix** — make the minimal change needed. No refactoring, no cleanup beyond the fix.
- [ ] **8. Validate the fix** — recipe must exit 0 whenever step 4 produced one; then typecheck/tests:
  ```bash
  cd {{REPO}}
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}}
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **8b. PR-grade proof run** (UI bugs) — slow + video, then sync evidence:
  ```bash
  bash {{recipe_validate_wrapper}} ... --slow 2000 --record-video=full-run --task-dir {{TASK_DIR}}
  ```
- [ ] **8c. Evidence manifest** — `evidence-manifest.json` with before/after pairs + `videos.after: artifacts/after.mp4` for gateway PR embed.
- [ ] **8d. Recipe coverage** — when `recipe.json` exists, write `recipe-coverage.md` (gateway computes recipe-quality) and run `check-task-artifact-contract.mjs --require-recipe-coverage-if-recipe`.
- [ ] **9. Self-review** — read the diff (`git diff`) against `{{review_quality_path}}`. Check for: inline type duplication (use `@farmslot/protocol`), swallowed exceptions, unnecessary helpers, comments that restate code.
- [ ] **10. Commit** — single commit following the repo's Lore commit protocol.
- [ ] **11. Prepare local PR package** — keep the branch local; do not run `git push`, `gh pr create`, `gh pr edit`, or `gh pr comment`.
- [ ] **12. Draft PR description artifact** — write the intended PR title/body to `{{TASK_DIR}}/artifacts/pr-description.md`; the gateway publishes it only after human approval.
- [ ] **12a. Optional visual evidence manifest** — if screenshots/videos prove the fix, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` using the strict schema below. Use `before_after_pairs` for comparisons; unknown top-level keys are invalid. Omit this file when there is no visual evidence.
  ```json
  {
    "version": 1,
    "preferred_mode": "screenshots",
    "before_after_pairs": [
      {
        "label": "Bug before/after",
        "covers": ["ac1"],
        "before": "artifacts/before-ac1.png",
        "after": "artifacts/after-ac1.png"
      }
    ],
    "standalone": [{ "label": "Fixed final state", "covers": ["ac2"], "file": "artifacts/after-ac2.png" }],
    "omit": ["artifacts/redundant.png"],
    "videos": { "after": "artifacts/after.mp4", "preferred": true, "note": "Full recipe replay at 2s slow playback" }
  }
  ```
- [ ] **13. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence for family retrospective and improvement. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
- [ ] **14. Update status** — set `STATUS: done`.
- [ ] **15. Write completion signal** — run: `{{TASK_DIR}}/mark complete --mark-last` (validates learnings, pr-description, checklist, artifact contract)
      **Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
