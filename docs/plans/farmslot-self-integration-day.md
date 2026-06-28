# Farmslot self-integration day — execution context

**Owner:** Arthur
**Date:** 2026-06-27
**Status:** Approved supporting plan (2026-06-27 dogfood day; retained as near-term handoff)
**Relates to:** [ADR-039](../adr/039-run-portable-bundles.md), [ADR-040](../adr/040-work-graph-orchestration.md) (future), [ROADMAP-next.md](../ROADMAP-next.md), [worktree-operator-model.md](../operations/worktree-operator-model.md)

## Why this exists

Arthur's near-term chain is blocked on **ADR-039 working in production**, not on more architecture docs.

Today the dev loop is: agents in tmux runners on worktrees **without** launching work through Farmslot (`run.create` / interactive `dev`). That means:

- No unified run history on the canonical gateway (7777)
- Companion does not see parallel agent work
- Worktree sandboxes cannot seed baselines from main history
- Roadmap → backlog → parallel dispatch (ADR-040 direction) has no validated first rung

This plan captures the 2026-06-27 dogfood goal and the next goal so every agent/session can align without re-explaining context.

## North star (this week)

1. **Merge PR #95 (ADR-039)** — portable `.farmrun` export/import, CI green, cross-review clean.
2. **Prove one simple Farmslot-originated dev run** — interactive `dev` dispatched via gateway/CLI, visible in Companion + `.runs/` on main operator plane.
3. **Prove worktree seeding** — export baseline from main → import into sandbox → run one eval or comparison trial.
4. **Translate one roadmap item → backlog item → dispatch** — single item, not epic graph yet.
5. **Parallel agents** — two+ interactive dev runs on isolated gateways/worktrees, history still recoverable via bundles + main operator plane.

Work graphs (ADR-040) come **after** steps 1–3 are boringly reliable.

## Operator model (steady state)

| Plane                | Port                     | Role                                                                                      |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| **Main operator**    | 7777 / Companion `local` | Canonical `.runs/`, real dispatches, history you care about                               |
| **Worktree sandbox** | 7778+                    | Gateway code experiments, seeded references, throwaway trials                             |
| **tmux runner**      | —                        | Worker execution surface; must be **dispatched by Farmslot**, not ad hoc `claude` in repo |

**Rule:** Even interactive dev with Grok/Claude/Codex in parallel should create **Run records** (lane `production` or `interactive dev`) so history is queryable and exportable.

## Today checklist

### A. Ship ADR-039 bundles and PR #95 backlog intake

- [ ] CI green (CLI, protocol, run-bundle, gateway, CC quality, hygiene)
- [ ] Cross-review loop on PR #95 (`cross-review-orchestrator`, reviewers Claude + Codex)
- [ ] Merge to `main`

### B. QA — import/export (manual + automated)

Automated (already in repo):

```bash
cd packages/run-bundle && yarn test    # round-trip seed mode
cd packages/cli && yarn test           # runs-cli-options
```

Manual live proof (main → worktree):

```bash
# Main — pick a real terminal dev/fix run id from .runs/ or Companion
cd ~/dev/farmslot
farmslot runs export <runId> -o /tmp/baseline.farmrun
farmslot runs bundle ls /tmp/baseline.farmrun

# Worktree sandbox
cd ~/dev/farmslot-worktrees/<branch>
farmslot runs import /tmp/baseline.farmrun --root "$PWD"
# or via gateway:
farmslot --url ws://localhost:7778 runs import /tmp/baseline.farmrun

# Verify: imported run ids in .runs/, prior-run or package eval seed works
```

Also test `--read-only` import for package-only eval path.

### C. First Farmslot-dispatched self-dev run

Pick **one** small farmslot roadmap/backlog item (docs-only or tiny gateway fix):

```bash
# Example shape — adjust to your backlog item id when created
farmslot run create --flow dev --mode interactive --project farmslot-farm --prepare-profile sandbox ...
# or backlog.enqueue handoff after backlog item exists
```

Success = run appears in `#runs`, Companion active runs, terminal on slot, **you did not** start the worker by hand in tmux without a run id.

### D. Document evidence

- [ ] `docs/operations/evidence/adr039-import-export-qa.json` (or sibling) after manual QA
- [ ] Note run ids used for the first gateway-originated dispatch

## Demo trajectory (MetaMask → Farmslot-native)

MetaMask farms remain the heavy integration test bed. For **demo** and **parallel agent** work, prefer:

- `farmslot-farm` / `example-browser-farm` for protocol/UI proofs — see [farmslot-unified-project-validation-plan.md](farmslot-unified-project-validation-plan.md)
- ADR-039 bundles to move **reference eval packages** between gateways without MM rebuild cost

Goal: more roadmap execution visible on Farmslot-native projects so demos do not require MM slot warmup.

## What not to do today

- Do not start ADR-040 implementation (Proposed only).
- Do not add epic graph scheduler code.
- Do not skip PR #95 merge to chase backlog graph — bundles are the prerequisite.

## Session handoff (copy to agents)

> All agent work on this repo should create Runs via gateway dispatch, not naked tmux. ADR-039 bundle import/export QA and PR #95 backlog intake must stay validated. Next: one backlog item dispatched through Farmslot; parallel agents use worktree sandboxes + bundle seed from main. Canonical history on 7777.
