# Farmslot review quality — PR reviewers

Read this **before** writing `{{TASK_DIR}}/artifacts/review.md`. Pair with `{{recipe_quality_path}}` when the PR ships recipe proof.

Load the critique skill when judging recipe/evidence quality: `.agents/skills/fs-recipe-quality/SKILL.md` (or run `/fs-recipe-quality`).

## Review scope

Farmslot reviews cover:

| Surface | Proof bar |
|---------|-----------|
| Command Center UI | Recipe v1 + CDP; screenshots/video; **read pixels** — never trust filenames alone |
| Gateway / protocol | `yarn typecheck`, `node:test`, behavior traceable in code |
| Mobile Companion | iOS/Android recipe when PR touches `apps/companion`; real Metro flag flips — no store injection |
| Publication evidence | `evidence-manifest.json`, hosted `raw.githubusercontent.com` URLs, `artifacts_repo` upload |

## Evidence audit (mandatory for UI PRs)

A green recipe status does **not** prove visible UI. Before marking an AC PROVEN:

1. **Read every evidence PNG** via the Read tool (PR-hosted URLs or `{{TASK_DIR}}/artifacts/*.png`).
2. Confirm the claimed text/component is **visible in the viewport** — not off-screen, wrong route, or generic shell.
3. For before/after pairs, confirm the **delta** matches the AC — not two identical frames.
4. If the PR embeds `raw.githubusercontent.com` URLs, **verify they return HTTP 200** (private `artifacts_repo` = 404 in PR bodies).
5. For video claims, confirm `after.mp4` exists with a `moov` atom when the author claims full-run proof.
6. **Reject UI state injection** — proof must come from real recipe/CDP/user flow, not mid-run store/DOM writes.

Verdict per AC: `PROVEN` | `WEAK` | `UNTESTABLE` | `MISSING`.  
`WEAK` or `MISSING` without reclassification -> `REQUEST_CHANGES` or explicit human escalation.

## Recipe scope

Recipes prove a **protocol action** through a **real client endpoint** (Command Center, CLI, gateway
RPC, `watch_logs`, Companion) — not UI only. Ask: which protocol actions changed, is each driven end
to end? Reject:

| Pattern | Verdict |
|---------|---------|
| "Gateway-only, no recipe possible" | **must_fix** — CLI/RPC/logs reach it |
| `#dev/*` fixture used to prove gateway *derivation* | **must_fix** — read back from the gateway |
| Review fixes landed with no new/updated recipe node | **must_fix** — the fix is unproven; extend and re-run |
| Fix applied to one call site while siblings share the defect | **must_fix** — enumerate the blast radius, fix the class |
| Only mocked unit tests defend the change | **must_fix** — proves the function, not the system |
| Asserts the call returned; claim is a side effect on another store | **must_fix** — assert that store |
| Screenshot for a state claim, or a log for a rendering claim | suggestion — wrong level |

Log and RPC assertions are first-class; do not demand a screenshot for a non-visual claim.

## Recipe quality gates

When the PR includes `recipe.json` or a **Validation Recipe** section:

- Apply `fs-recipe-quality` (recipe-only or recipe+evidence mode).
- Write `{{TASK_DIR}}/artifacts/recipe-coverage.md` with a per-AC matrix (gateway computes recipe-quality).
- **Forbidden:** silent AC skips, DOM-only proof for visible claims, fabricated `?sha=` URLs, CDP fallback claimed as native capture-helper without doctor note.

If the author omitted a recipe for a UI change, flag it — do not invent proof.

## Farmslot code antipatterns (check every diff)

| Pattern | Severity | Action |
|---------|----------|--------|
| Inline protocol types instead of `@farmslot/protocol` | suggestion | cite import path |
| Empty `catch {}` or log-and-continue | **must_fix** | root cause or explicit recovery |
| UI/store/DOM injection for "validation" | **must_fix** | require real user flow |
| Typecheck-only claim for UI change | **must_fix** | require CDP/recipe proof |
| `tsc -b` / emitting `.js` into source trees | **must_fix** | use `yarn typecheck` |
| Hardcoded project logic in `scripts/` | suggestion | should be `project.json` hook |
| Gateway breaks existing bash scripts | **must_fix** | coexistence rule |
| Slot helper exec hidden in `@farmslot/slot-config` / `farmslot internal` when it needs `execOnSlot` or `execLocal` | **must_fix** | implement as gateway method routed through `route-method.ts` |
| Script port changes slot-vs-orchestrator locality or swallows missing project config | **must_fix** | match original `run_on`/local split and preserve hard-fail behavior |
| Slow read-heavy gateway method only validated through 5s `cdp.mjs gateway` client | suggestion | confirm with real `farmslot --url` CLI before calling it hung |
| Missing `artifacts_repo` / broken publication upload | suggestion | config + SSH host + public repo |
| capture-helper TCC denied in tmux without CDP fallback note | suggestion | `capture-helper-tmux-check.sh` |
| CI warm handoff implemented via `nudgeReuse` | **must_fix** | `nudgeReuse` requires `agent=working` and rejects `lifecycle=held`; use `warmSessionReuse` which probes liveness on held/ci-watch slots |
| FIND_SLOT warm takeover rebinds `current_run_id` | **must_fix** | reserve `handoff_run_id` only (mirrors nudge pattern); rebinding `current_run_id` prevents DISPATCH from terminalizing the parent after handoff |

## CDP / capture-helper

Before live UI validation:

```bash
cd {{REPO}}
node apps/command-center/scripts/agentic/recipe-doctor.mjs \
  --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --slot-id {{SLOT}} --json
bash apps/command-center/scripts/debug-chrome.sh
```

From the **same tmux pane** that runs recipes:

```bash
bash projects/farmslot-farm/setup/capture-helper-tmux-check.sh
```

Doctor must pass native capture-helper when video proof is claimed.

## Publication / PR evidence

Hosted screenshots live in `deeeed/farmslot-artifacts` at `features/<PR_NUMBER>/` (dev), `fixes/<PR_NUMBER>/` (fix), `reviews/<PR_NUMBER>/` (review).

Re-upload or fix when:

- URLs 404 (private repo, wrong SSH host, never uploaded)
- `?sha=` digest does not match file bytes
- `## **Screenshots/Recordings**` still has local paths (`.sandbox/`, `/Users/`, `artifacts/recipe-run/`)

Use `/fs-pr-evidence` or:

```bash
node projects/farmslot-farm/setup/upload-pr-evidence.mjs --task-dir <dir> --pr <N> --flow feature --edit-pr
```

## Review report contract

`{{TASK_DIR}}/artifacts/review.md` must include:

1. **Summary** — what the PR does; aligned with stated goal?
2. **Recipe Coverage** — matrix from `recipe-coverage.md` or explicit skip rationale
3. **Evidence Audit** — per-AC visual verdicts; which PNGs you read
4. **Acceptance Criteria Validation** — table with PASS/FAIL/UNTESTABLE + evidence pointer
5. **Code Quality** — farmslot antipatterns from this doc
6. **Fix Quality** — best approach vs pragmatic; would-not-ship items
7. **Live Validation** — doctor, typecheck, tests, optional recipe re-run
8. **Recommended Action** — APPROVE | REQUEST_CHANGES | COMMENT

Also write `{{TASK_DIR}}/artifacts/line-comments.json` with `must_fix` | `suggestion` | `nitpick` severities.

## Cross-review

Independent review is required before merge (see repo `CLAUDE.md`). Reviewers use this doc + `fs-recipe-quality`; workers fix **all** blocking findings including nits when cross-review is active.
