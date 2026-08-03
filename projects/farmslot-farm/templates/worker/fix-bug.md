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
- [ ] **3. Read the bug + required surfaces** — understand the issue and record **which surfaces it needs** (only what ACs require): `gateway-cli` | `command-center` | `companion-device` (Companion on sim/device: install + launch; Metro alone ≠ ready). Boot/install **only** those surfaces: `command-center` → sandbox UI + CDP; `companion-device` → Companion **installed** on slot sim/device (`companion-prepare.sh full` or install scripts if missing; verify simctl/adb); `gateway-cli` → skip boots/installs. Block if a required surface cannot be made ready. Do not start unrelated runtimes.

> **Recipe scope.** Recipes prove a protocol action through a real client endpoint — Command Center,
> CLI, gateway RPC, or `watch_logs` — not UI only. "Backend-only, so no recipe" is never valid, and
> mocked unit tests are not a substitute. See `{{recipe_quality_path}}`.

- [ ] **4. Reproduce** — write `{{TASK_DIR}}/artifacts/recipe.json` from acceptance criteria using the required `$schema: "https://farmslot.io/schemas/recipe-v1.schema.json"`, `description`, and `workflow`, then run it against current code (must fail before the fix). Use state/command actions for backend and CLI bugs; browser/device actions only for visual claims on those surfaces. Omit the recipe only when no declared project action can exercise the bug, and record the exact limitation plus replacement deterministic reproduction. Read `{{recipe_quality_path}}` first.
  ```bash
  cd {{REPO}}
  # command-center bugs only (skip when step 3 is not command-center):
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
- [ ] **9. PR-grade proof run** (only when step 3 listed `command-center` or `companion-device`) — Command Center: slow + video. Companion device: real sim/device screenshots (not catalog-only). Gateway-cli-only: skip and state why.
  ```bash
  bash {{recipe_validate_wrapper}} ... --slow 2000 --record-video=full-run --task-dir {{TASK_DIR}}
  ```
- [ ] **10. Evidence manifest** — when step 3 listed a UI/device surface, `evidence-manifest.json` must reference real screenshots/video (empty pairs are not proof). Gateway-cli-only may omit visual evidence.
- [ ] **11. Recipe coverage** — when `recipe.json` exists, write `recipe-coverage.md` (gateway computes recipe-quality) and run `check-task-artifact-contract.mjs --require-recipe-coverage-if-recipe`.
- [ ] **12. Self-review** — read the diff (`git diff`) against `{{review_quality_path}}`.
- [ ] **12b. Blast radius** — list every caller, shared-state reader/writer, schema/doc, and test that
  references what you changed; verify each and fix sibling instances in the same pass.
- [ ] **12a. Extend + re-run the recipe for anything changed since the baseline** — each fix needs a node
  proving its claim, then a full re-run; act on what it shows. Prove each new node can fail. Check for: inline type duplication (use `@farmslot/protocol`), swallowed exceptions, unnecessary helpers, comments that restate code.
- [ ] **13. Commit** — single commit following the repo's Lore commit protocol.
- [ ] **14. Prepare local PR package** — keep the branch local; do not run `git push`, `gh pr create`, `gh pr edit`, or `gh pr comment`.
- [ ] **15. Draft PR description artifact** — write the intended PR title/body to `{{TASK_DIR}}/artifacts/pr-description.md`; the gateway publishes it only after human approval.
- [ ] **16. Optional visual evidence manifest** — if screenshots/videos prove the fix, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` using the strict schema below. Use `before_after_pairs` for comparisons; unknown top-level keys are invalid. Omit this file when there is no visual evidence.
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
- [ ] **17. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence for family retrospective and improvement. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
- [ ] **18. Update status** — set `STATUS: done`.
- [ ] **19. Write completion signal** — run: `{{TASK_DIR}}/mark complete --mark-last` (validates learnings, pr-description, checklist, artifact contract)
      **Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
