# Farmslot cross-surface evidence E2E goal

Status: active  
Use as: `/goal docs/plans/farmslot-cross-surface-evidence-e2e-goal.md`  
Supports: `docs/ROADMAP-next.md` dev publication gate, recipe evidence promotion (`fix/farmslot-farm-worktree-deps-install`), Command Center + Mobile Companion operator surfaces.

## Goal

Validate the **full farmslot operator loop twice** — once per app — with matching demo banners, recipe proof (screenshots **and** MP4), evidence promotion, monitor checklist, and **draft** publication gate on both runs.

**Success bar:** every step green. No recipe `fail`, no video ENOENT, no `BLOCKED` SIGNAL, no skipped publication gate, no screenshot-only fallback unless video capture is fixed first.

| Run | App | Slot | Ticket |
| --- | --- | --- | --- |
| **A** | Command Center | `macwork-ff-2` | [deeeed/farmslot#28](https://github.com/deeeed/farmslot/issues/28) (exists) |
| **B** | Mobile Companion | `macwork-fc-1` | [deeeed/farmslot#29](https://github.com/deeeed/farmslot/issues/29) (create before Run B) |

Both tasks are **DO NOT MERGE** smoke work. Success means pipeline + evidence UX, not merge to `main`.

## References

- Recipe example (CC): `docs/examples/recipes/farmslot/demo-red-banner.recipe.json`
- Recipe example (Companion evidence): `docs/examples/recipes/farmslot/mobile-companion.recipe.json`
- Recipe quality contract: `projects/farmslot/fixtures/runtime/recipe-quality.md`
- Tooling branch: `fix/farmslot-farm-worktree-deps-install` (`9dcc84e`…`563c7d5`)
- Monitor checklist fix: `task.progress` reads `CHECKLIST.md` when present; autonomous `dev.md` uses `TASK.md` checkboxes

## Phase 0 — Tooling green (blocker)

Do **not** dispatch Runs A/B until this phase is all green.

- [ ] Merge or deploy `fix/farmslot-farm-worktree-deps-install` on the gateway host; restart gateway.
- [ ] Fix video capture so proof runs exit **0** with `after.mp4` present (current failure: `recipe-run.mp4` ENOENT on `record.video`).
- [ ] Doctor passes on Command Center / ff-2:
  ```bash
  node apps/command-center/scripts/agentic/recipe-doctor.mjs \
    --cdp-port 9323 --gateway-port 8809 --slot-id macwork-ff-2 --json
  ```
- [ ] Companion health passes on fc-1 (after Metro up):
  ```bash
  bash projects/farmslot/setup/companion-prepare.sh health \
    --slot-port 8871 --platform ios
  ```
- [ ] Dry-run proof command resolves primary-repo runner (not worktree copy):
  ```bash
  bash projects/farmslot/setup/validate-recipe.sh --dry-run \
    --recipe docs/examples/recipes/farmslot/demo-red-banner.recipe.json \
    --artifacts-dir /tmp/recipe-dry --gateway-port 8809 --slot-id macwork-ff-2
  ```
- [ ] Cancel or complete stale runs (`9d783340`, `f201cf98`).

**Phase 0 done when:** a manual proof run on #28 task artifacts produces `recipe-run/summary.json` with `"status": "pass"` **and** `artifacts/after.mp4` after `--task-dir` sync.

## Phase 1 — Run A: Command Center banner (#28)

### Dispatch config

```
project:     farmslot
slot:        macwork-ff-2
platform:    cli
flow:        dev
mode:        autonomous
template:    dev.md
prepare:     sandbox
branch:      feat/28-add-demo-red-banner
runner:      claude / opus
publication: draft PR
```

Worktree: `farmslot-wt/farmslot-2` · gateway port **8809** · CDP **9323**

Reuse existing `app-shell.ts` banner work when still valid; worker should not re-implement from scratch.

### Implementation contract

- Env gate: `VITE_FARMSLOT_DEMO_BANNER=1`
- Copy (exact): `FARMSLOT DEMO: PARALLEL RUN MONITORING`
- Off by default; red bar on app chrome; does not block primary navigation
- `cd apps/command-center && yarn typecheck` passes

### Recipe + evidence (all must pass)

- `artifacts/recipe.json` — adapt `docs/examples/recipes/farmslot/demo-red-banner.recipe.json`
- Fast regression run → exit 0
- Proof run:
  ```bash
  bash projects/farmslot/setup/validate-recipe.sh \
    --recipe <TASK_DIR>/artifacts/recipe.json \
    --artifacts-dir <TASK_DIR>/artifacts/recipe-run \
    --runtime-dir .sandbox/farmslot/agent \
    --platform web --cdp-port 9323 --gateway-port 8809 \
    --slot-id macwork-ff-2 --slow 2000 --record-video=full-run --task-dir <TASK_DIR>
  ```

**Hard gates:**

- `recipe-run/summary.json`: `"status": "pass"`, `"failed": 0`
- Promoted under `artifacts/`: `before-*.png`, `after-*.png`, `after.mp4`
- `evidence-manifest.json`, `recipe-coverage.md`, `recipe-quality.json`
- `node scripts/quality/check-task-artifact-contract.mjs <TASK_DIR> --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe` → exit 0
- `artifacts/pr-description.md` with Screenshots/Recordings placeholder
- `artifacts/report.md` listing evidence paths
- Worker `./mark complete --mark-last`; **do not** `/exit` (gate-held session)

### UI / engine gates

- [ ] Monitor shows full `dev.md` phased checklist (not 0/N)
- [ ] `complete` builds local-first PR package with evidence digests
- [ ] Human-gate **Evidence** tab: before/after images + video playable
- [ ] **PR Preview** tab: embedded media from manifest (not placeholder text)
- [ ] Approve **draft** publication → GitHub draft PR created
- [ ] Run → `done` / `success`; slot releases cleanly

**Record Run A ID** — Run B optional cross-surface recipe segment references it.

## Phase 2 — Run B: Companion banner (#29)

### Ticket to create (paste into GitHub before dispatch)

**Title:** `[FARMSLOT DEMO - DO NOT MERGE] Companion: red debug banner for mobile dispatch smoke`

**Summary:** Demo-only red banner on Mobile Companion to exercise farmslot dispatch → worktree → iOS recipe proof → publication gate. DO NOT MERGE.

**Acceptance criteria:**

1. With demo flag **off**, banner is **not** visible anywhere in Companion.
2. With demo flag **on**, banner shows on the main shell with text exactly: `FARMSLOT DEMO: MOBILE OPERATOR MONITORING`
3. Change is isolated (one component + env wiring), easy to revert.
4. `cd apps/companion && yarn typecheck` passes.
5. Recipe proof on iOS simulator via companion runner (`platform: ios`), not typecheck alone.
6. *(Recommended)* Companion run-detail can open Run A and show its recipe evidence (before/after from #28).

### Dispatch config

```
project:     farmslot
slot:        macwork-fc-1
platform:    ios
app:         companion
flow:        dev
mode:        autonomous
template:    dev.md
prepare:     companion-warm    # companion-full if native rebuild needed
branch:      feat/29-add-companion-demo-banner
runner:      claude / opus
publication: draft PR
```

Worktree: `farmslot-wt/farmslot-companion-1` · gateway port **8871** · simulator **fc-1**

### Implementation contract

- Env gate: `EXPO_PUBLIC_FARMSLOT_DEMO_BANNER=1` (or project convention)
- Distinct copy from Command Center so screenshots are unambiguous
- Top safe-area banner; does not block tab navigation

### Recipe + evidence

- Task-local `artifacts/recipe.json` with companion `ui.navigate` / `ui.wait_for` / `ui.screenshot` nodes
- Proof run:
  ```bash
  bash projects/farmslot/setup/validate-recipe.sh \
    --recipe <TASK_DIR>/artifacts/recipe.json \
    --artifacts-dir <TASK_DIR>/artifacts/recipe-run \
    --runtime-dir .sandbox/farmslot/agent \
    --platform ios --metro-port <derived> --simulator fc-1 \
    --gateway-port 8871 --slot-id macwork-fc-1 \
    --slow 2000 --record-video=full-run --task-dir <TASK_DIR>
  ```
- Same hard gates as Run A (pass summary, MP4, manifest, contract, publication gate)

### Optional cross-surface proof (recommended)

After Run A is `done`, extend Run B recipe:

- Open run detail for Run A `run_id`
- Assert evidence / recipe-run selector visible
- Screenshot: `screenshots/companion-shows-cc-evidence.png`
- Include in `evidence-manifest.json` as `standalone` or additional pair

## Phase 3 — Program-level acceptance

| # | Criterion |
| --- | --- |
| 1 | Two autonomous runs, both `done` / `success`, zero failed engine steps |
| 2 | Both recipes: `summary.json` status `pass`, `failed: 0` |
| 3 | Both tasks: `after.mp4` + before/after PNGs under `artifacts/` |
| 4 | Both: `check-task-artifact-contract.mjs` exit 0 |
| 5 | Both: draft PRs on GitHub with embedded media from manifest |
| 6 | Publication gate opened and approved for both without validation errors |
| 7 | `yarn typecheck` clean in `apps/command-center` and `apps/companion` on respective branches |
| 8 | No operator mid-run steering (autonomous only) |
| 9 | Monitor checklist advanced via `./mark` on `TASK.md` |
| 10 | Gateway logs: recipe/video failures surface as run `failed`, not silent pass |

## Execution order

```
Phase 0 (fix video + deploy gateway)
    ↓
Run A: dispatch #28 → monitor → complete → human-gate → draft PR → done
    ↓
Create #29 on GitHub
    ↓
Run B: dispatch #29 → monitor → complete → human-gate → draft PR → done
    ↓
(Optional) Companion surfaces Run A evidence in Run B recipe
    ↓
Program sign-off
```

Runs are **sequential** so Run B can reference Run A `run_id` and Phase 0 video fix is proven once before mobile complexity.

## Out of scope

- Merging either PR to `main`
- Lightweight interactive profile (smoke-tested separately on `9d783340`)
- Docusaurus / docs site media capture
- CI-watch on remote PRs
- New gateway protocol changes

## One-liner

Dual-surface clean E2E: fix recipe video capture, then autonomous `dev.md` Run A (#28, CC banner, `macwork-ff-2`) and Run B (#29, Companion banner, `macwork-fc-1`) — each with pass recipe, MP4, evidence manifest, monitor checklist, and draft publication gate with embedded media; optionally Companion surfaces Run A evidence.