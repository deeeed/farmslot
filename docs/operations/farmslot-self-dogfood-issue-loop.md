# Farmslot self-dogfood: issue → agent fix loop

**Owner:** Arthur / Farmslot  
**Status:** Active operator procedure  
**Relates to:** [ADR-026](../adr/026-self-improvement-recursive-loop.md), [ADR-039](../adr/039-run-portable-bundles.md), [worktree-operator-model.md](worktree-operator-model.md), [ROADMAP-next.md](../ROADMAP-next.md) (unified `farmslot-farm` validation), [GitHub #122](https://github.com/deeeed/farmslot/issues/122)

## Purpose

We use Farmslot to improve Farmslot. Not every fix needs a **farmslot run** (slot prepare, worker tmux, recipe proof). Framework bugs (gateway, prepare, dispatch, UI, scripts) should be **recorded**, **root-caused**, and **fixed via agent + PR** first. Full slot dispatches and E2E goals come **after** stabilization.

This doc defines the loop when the fix does **not** yet go through `run.create`.

---

## Two improvement paths

| Path | When to use | Record | Fix | Prove |
|------|-------------|--------|-----|-------|
| **A — Agent-direct** (default for framework) | Gateway/prepare/dispatch/UI/script bugs; repro is unit test or local command | GitHub issue `dogfood` | Agent on feature branch → PR | Unit tests + `yarn typecheck` + targeted smoke |
| **B — Run-mediated** | Needs slot, worker, recipe, device, or publication gate | GitHub issue + optional `run.create` | Autonomous/comparison run on `farmslot-farm` | Recipe + artifact contract + gate invariants |
| **C — Run-learned** | Insight from a **completed** run | Retrospective + `learnings.md` | `run.proposeImprovement` / improvement engine (ADR-021) | Human apply + follow-up run |

**Rule:** If the bug is in `services/gateway`, `scripts/`, or `apps/command-center` and you can write a failing test without a worker — use **Path A**. Do not burn a slot to debug prepare timeouts.

---

## Path A workflow (agent-direct, no run)

### 1. Record — GitHub issue

Use the **Dogfood / framework** issue template (`.github/ISSUE_TEMPLATE/dogfood-framework.yml`).

Required fields:

- **Symptom** — what broke (one paragraph)
- **Root cause** — one sentence diagnosis (bandage vs real fix decided here)
- **Reproduction** — command, log snippet, or test that fails without a slot
- **Proposed fix** — long-term shape (not symptom patch)
- **Priority** — P0 blocker / P1 reliability / P2 harness / P3 docs
- **Area** — `gateway` | `prepare` | `dispatch` | `ui` | `scripts` | `e2e-harness`

Label: `dogfood`. Link related issues (e.g. umbrella [#122](https://github.com/deeeed/farmslot/issues/122)).

**Do not** put scratch evidence in `docs/` — keep logs in issue comments or ignored task dirs.

### 2. Triage

- **P0** — blocks dispatch/prepare/gate correctness; merge before any E2E retry
- **P1** — reliability under load or retry; merge before parallel comparison
- **P2** — observability, harness, ergonomics
- **P3** — docs-only

One issue = one root cause. Split combined failures (e.g. fixture timeout ≠ gate reuse).

### 3. Fix — agent session (no `run.create`)

```text
main → fix/<area>-<short-slug>   # e.g. fix/gateway-worktree-startref-comparison
```

Agent checklist:

1. State root cause in PR description (same sentence as issue)
2. Implement **long-term fix** — no swallowed exceptions, no bandage without callout
3. Add or extend **unit test** in `services/gateway` (or relevant package)
4. `cd apps/command-center && yarn typecheck`
5. Targeted smoke if applicable (e.g. `sync-fixtures.sh --slot macwork-ff-3`, single `run.create` smoke) — optional for pure logic fixes

**No** full observability E2E until umbrella stabilization checklist is green.

### 4. Review + merge

- Conventional commit + PR title
- `/review` (independent reviewer) before merge suggestion
- Close issue with PR link; if umbrella tracker (#122), check off sub-item

### 5. Deploy to operator gateway

After merge to `main`: restart canonical gateway (`7777`) or worktree sandbox if developing gateway itself. E2E and dispatches use **one** canonical `.runs/` dir.

---

## Path B workflow (run-mediated)

Use when the fix **must** be validated on a slot (recipe, worker prompt, companion device, publication gate UX).

1. Open or link GitHub issue (same template)
2. Confirm **stabilization P0** for that area is merged (see #122)
3. Dispatch with explicit contract:
   - Comparison: `lane=comparison`, `artifact-only`, omit `branch`, shared `familyId`
   - Production autonomous: `mode:autonomous`, `dev.md`, poll to `blocked` at human-gate, `not_published`
4. Never reuse terminal runs for gate proofs
5. Capture run id + task dir in issue comment; artifact contract exit 0
6. Framework fix still goes through **PR** — the run is evidence, not the delivery mechanism

---

## Path C workflow (run-learned)

For improvements discovered **after** a successful or graded run:

1. Worker writes `artifacts/learnings.md`
2. Retrospective decision → Accept for learning
3. Improvement engine proposes template/fixture/script diffs
4. Human applies via improvement UI — never auto-apply

Path C does not replace Path A for bugs found during E2E debugging — file **Path A issues** immediately; optionally backfill learnings later.

---

## Verification ladder (do not skip rungs)

```text
1. Unit test (gateway/package)     ← minimum for Path A merge
2. yarn typecheck (command-center)
3. Targeted smoke (one slot, one command)
4. Parallel comparison smoke (3 slots)   ← after P1 prepare/dispatch fixes
5. Full cross-surface E2E goal          ← only when #122 checklist complete
```

Claiming E2E success at rung 2 is invalid for UI/gate/recipe AC.

---

## Umbrella tracking

Large dogfood efforts (e.g. observability E2E stabilization) use:

- **One umbrella GitHub issue** with checklist (#122)
- **Child issues** per root cause (linked via "Relates to #122")
- **Scratch backlog** in ephemeral goal dirs — not committed
- **Goal plan** frozen until umbrella exits

---

## Anti-patterns

| Anti-pattern | Why wrong | Do instead |
|--------------|-----------|------------|
| Full E2E to debug prepare timeout | Confounds framework + worker + load | Path A issue + fixture timing smoke |
| Reuse `done` run for gate proof | Skips human gate | Fresh dispatch; assert `blocked` |
| Agent loop `run.create` without issue | Loses root cause trace | Open issue first |
| Fix without test | Regresses silently | Failing test → fix → green |
| Draft PR before gate approval | Violates local-first publication | Stop at `not_published` |

---

## Quick reference: #28 / comparison dispatch (after P0 merge)

```json
{
  "flowType": "dev",
  "project": "farmslot-farm",
  "ticketOrPr": "deeeed/farmslot#28",
  "lane": "comparison",
  "variant": "<claude|codex|grok>",
  "completionPolicy": "artifact-only",
  "startRef": "main",
  "familyId": "<uuid>",
  "prepareProfile": "sandbox",
  "slotId": "macwork-ff-<n>"
}
```

Omit `branch`. Do not pass shared production branch names.