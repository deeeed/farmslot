# Worker: Feature — {{TICKET_ID}}

> **Signal file:** `./mark N` for progress; `SIGNAL.json` only when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete --outcome success` (never `echo > SIGNAL.json`).

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

**Publication model:** keep the workspace local-first. Do not run `git push`, `gh pr create`,
`gh pr edit`, or `gh pr comment`. The gateway will prepare a validated workspace package for
human approval, optional independent review, and CI only after publication.

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

### Recipe tooling

Resolve once, then reuse:

```bash
cd {{REPO}}
RUNNER="node {{recipe_runner_resolve_cmd}}"
MANIFEST="{{recipe_manifest_path}}"
WRAPPER="{{recipe_validate_wrapper}}"
```

Read `{{recipe_quality_path}}` before writing any recipe.

## Checklist

Execute top-to-bottom. After each step, run `{{TASK_DIR}}/mark N`. STOP at failures — fix before proceeding.

### Phase 1: Setup

- [ ] **1. Confirm recipe runtime** — doctor must pass before UI proof:
  ```bash
  cd {{REPO}}
  node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --slot-id {{SLOT}} --json
  bash apps/command-center/scripts/debug-chrome.sh
  ```
  If CDP or the sandbox UI is down, set `STATUS: blocked` with the failing check and stop.
- [ ] **2. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md`.
- [ ] **3. Update status** — set `STATUS: working`, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 3`.
- [ ] **4. Read requirements** — map acceptance criteria to proof mode (`state`, `visual`, `mixed`) in this TASK file.
- [ ] **5. Create branch** — `git checkout -b {{BRANCH}}`

### Phase 2: Baseline recipe (UI/command-center ACs)

Skip Phase 2 only when every AC is backend-only with zero Command Center surface. State the reason in this TASK file.

- [ ] **6. Write `{{TASK_DIR}}/artifacts/recipe.json`** — cover all acceptance criteria using manifest actions from `{{recipe_manifest_path}}`. For modifications, the recipe should fail on current code before your fix.
- [ ] **7. Baseline recipe run** — must exit non-zero on unfixed code (or document `Baseline: N/A — purely additive` with rationale):
  ```bash
  cd {{REPO}}
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run-baseline \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}}
  ```

### Phase 3: Implement

- [ ] **8. Implement** — types in `packages/protocol`, gateway logic in `services/gateway`, UI in `apps/command-center/ui`.
- [ ] **9. Unit tests** — add `node:test` coverage for new gateway logic when applicable.

### Phase 4: Validate

- [ ] **10. Typecheck + gateway tests**:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **11. Recipe regression (fast)** — must exit 0 after the fix (no video):
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
  ```

### Phase 5: PR-grade recipe evidence (required for Command Center UI)

Skip only when every AC is backend-only with zero UI surface — state why in this TASK file.

- [ ] **12. Proof run with video** — slow playback + full-run MP4 for publication:
  ```bash
  cd {{REPO}}
  bash apps/command-center/scripts/debug-chrome.sh
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}} \
    --slow 2000 \
    --record-video=full-run \
    --task-dir {{TASK_DIR}}
  ```
  (`validate-recipe.sh` auto-promotes screenshots + `after.mp4` into `artifacts/` when `--task-dir` is set.)
- [ ] **12a. Validate screenshots (HARD GATE)** — Read each promoted `artifacts/before-*.png` and `artifacts/after-*.png` via the Read tool. The claimed UI must be visible — not off-screen, wrong route, or generic shell. Re-run step 12 if not.
- [ ] **12b. Write `{{TASK_DIR}}/artifacts/evidence-manifest.json`** — gateway uses this to embed screenshots + `after.mp4` in the created PR. Follow `{{recipe_quality_path}}` (before/after pairs + `videos.after: artifacts/after.mp4`).
- [ ] **12c. Recipe coverage + quality** — `recipe-coverage.md` + `recipe-quality.json`. Visual ACs cannot be `pass` without screenshot/video proof.
- [ ] **12d. Artifact contract**:
  ```bash
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe
  ```

### Phase 6: Report + package

- [ ] **13. Self-review** — read the diff; no inline protocol duplication or comment noise.
- [ ] **14. Commit** — atomic commit(s) following Conventional Commits.
- [ ] **15. Write `{{TASK_DIR}}/artifacts/pr-description.md`** — include `## **Screenshots/Recordings**` placeholder (`_Evidence will be added after upload._`); gateway replaces from `evidence-manifest.json`. Append `## **Validation Recipe**` with `recipe.json` in a `<details>` block when present.
- [ ] **16. Report + signal** — write `{{TASK_DIR}}/artifacts/report.md` (list evidence paths: screenshots + `after.mp4`), set `STATUS: done`, then:
  ```bash
  {{TASK_DIR}}/mark complete --outcome success --mark-last
  ```
  **Do NOT `/exit`.** Stay alive for the publication gate.

## Recipe rules

- Use only manifest-declared actions.
- Never inject UI/store state to manufacture proof — drive the real flow via recipe/CDP.
- If you remove your code, the recipe must fail.
- Companion/mobile ACs: switch to companion runner via the same `{{recipe_validate_wrapper}}` on an `ios`/`android` slot when the ticket requires device proof.