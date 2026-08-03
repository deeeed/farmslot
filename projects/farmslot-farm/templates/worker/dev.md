# Worker: Feature — {{TICKET_ID}}

> **Signal file:** `./mark N` for progress; `SIGNAL.json` only when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

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

### Repo boundaries — where proof artifacts live

Everything this run produces to PROVE the work — `recipe.json`, evidence, reports — lives in `{{TASK_DIR}}/artifacts/`, never scattered into the repository. Reusable recipes go only into the repo's existing recipe homes (follow current conventions for the surface you changed); never invent a new proof folder. If a ticket asks for "repeatable" validation without naming a home, keep the script in `{{TASK_DIR}}/artifacts/` and raise the destination question in your report.

## Checklist

Execute top-to-bottom. After each step, run `{{TASK_DIR}}/mark N`. STOP at failures — fix before proceeding.

### Phase 1: Setup

- [ ] **1. Read requirements** — map acceptance criteria to proof mode (`state`, `visual`, `mixed`) in this TASK file. Record **which surfaces the ticket actually needs** (choose only what ACs require; default is none extra):
  - `gateway-cli` — backend/gateway only. **Still needs a recipe** via CLI/RPC/logs (Phase 2).
  - `command-center` — Command Center browser UI (CDP / Vite)
  - `companion-device` — Companion app UX on the slot sim/device (install + launch; Metro alone is not enough)
  Recipe proof is the default for every mode; surface list decides what (if anything) to boot in step 4 and which evidence Phase 5 needs.
- [ ] **2. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md`.
- [ ] **3. Update status** — set `STATUS: working`, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 3`.
- [ ] **4. Confirm required surfaces only** — boot or install **only** what step 1 listed. Do **not** start Companion, Command Center UI, CDP Chrome, or device installs when the ticket does not need them. Record skips in this TASK file.
  - **`command-center` only when listed:**
    ```bash
    cd {{REPO}}
    node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --slot-id {{SLOT}} --json
    bash apps/command-center/scripts/debug-chrome.sh
    ```
    If CDP or the sandbox UI is down and ACs need Command Center, set `STATUS: blocked` with the failing check and stop.
  - **`companion-device` only when listed:** Companion must be **installed and launchable** on the slot sim/device (`ios-sim` / adb). Prepare “healthy” / Metro listening ≠ app installed. If missing, install via project prepare (`companion-prepare.sh full` with slot gateway/metro/sim or adb) or the Companion install scripts — then verify with `simctl listapps` / `adb` that the Companion bundle is present. Do not treat `--catalog-only`, typecheck, or unit tests as device UX proof. If install is required and fails, set `STATUS: blocked` and stop.
  - **`gateway-cli` only:** skip this step’s boots/installs entirely.
- [ ] **5. Create branch** — `git checkout -b {{BRANCH}}`

### Phase 2: Baseline recipe (all executable ACs)

**A recipe proves a protocol action through a real client endpoint** — Command Center (`ui.*`), CLI
(`command` → `farmslot …`), gateway RPC (`command` → `cdp.mjs gateway …`), logs (`watch_logs`), or
Companion. Not UI-only. Assert at the level that proves the claim: screenshots for rendering, log/RPC
reads for state and cross-store effects. Never proof: "backend-only"; mocked unit tests; a `#dev/*`
fixture when the claim is that the gateway *derives* the value; asserting a call returned when the
claim is its side effect. Endpoint/assertion table: `{{recipe_quality_path}}`.

Skip Phase 2 only when no manifest action reaches the change through **any** endpoint above; state
the limitation and replacement validation here.

- [ ] **6. Write `{{TASK_DIR}}/artifacts/recipe.json`** — cover all acceptance criteria using manifest actions from `{{recipe_manifest_path}}`. The document must include the required `$schema: "https://farmslot.io/schemas/recipe-v1.schema.json"`, `description`, and `workflow`. For modifications, the recipe should fail on current code before your fix.
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

### Phase 5: PR-grade recipe evidence (required when step 1 listed a UI/device surface)

Skip when step 1 is `gateway-cli` only (no Command Center UI and no Companion device ACs) — state why in this TASK file. For `command-center`, keep the CDP video path below. For `companion-device`, capture real device/sim screenshots (not catalog-only HTML) into `artifacts/` and list them in `evidence-manifest.json`.

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
- [ ] **13. Validate screenshots (HARD GATE)** — Read each promoted `artifacts/before-*.png` and `artifacts/after-*.png` via the Read tool. The claimed UI must be visible — not off-screen, wrong route, or generic shell. Re-run step 12 if not.
- [ ] **14. Write `{{TASK_DIR}}/artifacts/evidence-manifest.json`** — gateway uses this to embed screenshots + `after.mp4` in the created PR. Follow `{{recipe_quality_path}}` (before/after pairs + `videos.after: artifacts/after.mp4`).
- [ ] **15. Recipe coverage** — `recipe-coverage.md` (gateway computes recipe-quality). Visual ACs cannot be `pass` without screenshot/video proof.
- [ ] **16. Artifact contract**:
  ```bash
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe
  ```

### Phase 6: Report + package

- [ ] **17. Self-review** — read the diff against `{{review_quality_path}}` antipatterns; no inline protocol duplication or comment noise.
- [ ] **18. Blast radius** — for each thing you changed, list every caller, other reader/writer of the
  same state, schema/doc describing it, and its tests; verify each. If one site had the bug, fix its
  siblings in the same pass rather than waiting for review to find them.
- [ ] **19. Extend + re-run the recipe for anything you changed since Phase 2** — every review or self-review fix
  needs a node proving its claim, then a full re-run. Act on the result: failing node means fix the code, or fix an
  assertion that over-claims. Prove each new node can fail before trusting it. Unit tests do not cover wiring.
- [ ] **20. Commit** — atomic commit(s) following Conventional Commits.
- [ ] **21. Write `{{TASK_DIR}}/artifacts/pr-description.md`** — include root cause, fix summary, test results, and evidence paths (screenshots + `after.mp4`). Include `## **Screenshots/Recordings**` placeholder (`_Evidence will be added after upload._`); gateway replaces from `evidence-manifest.json`. Append `## **Validation Recipe**` with `recipe.json` in a `<details>` block when present.
- [ ] **22. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence for family retrospective and improvement. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
- [ ] **23. Signal completion** — set `STATUS: done`, then:
  ```bash
  {{TASK_DIR}}/mark complete --mark-last
  ```
  `./mark complete --mark-last` validates learnings, pr-description, checklist completion, and artifact contract.
  **Do NOT `/exit`.** Stay alive for the publication gate.

## Recipe rules

- Use only manifest-declared actions.
- Never inject UI/store state to manufacture proof — drive the real flow via recipe/CDP.
- If you remove your code, the recipe must fail.
- Boot/install only surfaces step 1 required — no opportunistic Companion or CC bring-up.
- Companion/mobile ACs (`companion-device`): app must be installed on the slot device before proof; use the same `{{recipe_validate_wrapper}}` / companion capture path for device evidence, not catalog-only stubs.
