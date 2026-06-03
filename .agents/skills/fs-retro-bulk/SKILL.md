---
name: fs-retro-bulk
description: Process pending farmslot retros in bulk — extract a digest, curate learnings into LEARNINGS.md, then resolve the decisions in one pass. Use when the retro inbox has accumulated more than ~5 unresolved items and per-retro accept/dismiss in the UI is too slow, or when you want to feed several runs' signal into the self-improvement loop at once.
---

# FS Retro Bulk

Pending retros pile up in `.runs/<id>.json` as `decisions[]` entries with `type:retrospective` + `resolvedAt:null`. The UI's per-retro accept/dismiss is great when one or two land, but it scales badly: each `accept` triggers an LLM analysis pass via `improvement-engine.ts::analyzeAndPropose()` and each `dismiss` loses the signal entirely. When 10+ retros queue up, neither path is right.

This skill replaces the per-retro loop with a **3-pass bulk workflow**: extract → curate → resolve.

## When to invoke

- Retro inbox shows ≥ 5 pending items.
- Multiple runs in the same flow/family want a single consolidated learning, not one per run.
- You want to seed `LEARNINGS.md` from a window of activity (sprint retro, weekly review).

Skip when:

- A single high-signal retro is sitting alone — use the UI's accept flow so the improvement-engine can propose template diffs.
- Gateway is down — extraction works but Pass 3 needs the WS RPC.

## Inputs / outputs

- **Inputs:** `.runs/<id>.json` (read-only).
- **Pass 1 output:** `.omc/retro-digest/<YYYY-MM-DD>-<project>.md` per project — flow-grouped retros with PR links, ciWatch, REAL-triaged review items, run IDs.
- **Pass 2 output:** appended/created `projects/<name>/learnings/LEARNINGS.md` entries — curated by the human, never auto-appended (per `farmslot/CLAUDE.md` learnings-file rule).
- **Pass 3 output:** `.omc/retro-digest/<YYYY-MM-DD>-resolved.log` audit trail; each pending retro decision has `resolvedAt` + `resolvedAction:'dismiss'` set via the gateway WS API.

## Pass 1 — Extract

```bash
python3 scripts/extract-pending-retros.py
```

Idempotent and read-only. Walks `.runs/`, filters for unresolved retros, groups by project + flow, writes per-project digest markdown. Counts and a flat list of run IDs are emitted in a fenced block at the top — Pass 3 reads them straight back.

The digest tags REAL review items vs out-of-scope-bot rows from each `payload.reportExcerpt`. Use this to spot signal density before deciding whether a retro deserves a curated entry or just a quiet dismiss.

## Pass 2 — Curate

This pass is **not automated**. Read both digests, decide what's actionable, hand-write entries into:

- `projects/<name>/learnings/LEARNINGS.md` for each affected project

Format mirrors existing entries — H2 per run or per template-change, bullets for findings, **bold** the actionable change. Cross-project lessons go in both files (or in a single `## Template additions (date)` section if the change applies to both templates).

Hard rule from `farmslot/CLAUDE.md`: **never auto-append to LEARNINGS.md**. Clean runs (0 nudges, no REAL items) get no entry. Curate, don't dump.

If a learning maps to a concrete template change (worker/self-review/pr-complete/dev/fix-bug), apply it now — surgical edits, not template rewrites. Reference the run IDs that motivated each change in the LEARNINGS entry. Keep template diffs minimum-change: prefer adding one bullet to an existing checklist over restructuring a section.

## Pass 3 — Resolve

```bash
# Resolve every pending retro (matches Pass 1 output exactly):
python3 scripts/bulk-resolve-retros.py --all-pending

# Or scope to one digest:
python3 scripts/bulk-resolve-retros.py --from-digest .omc/retro-digest/2026-05-07-example-browser.md

# Or a hand-picked subset:
python3 scripts/bulk-resolve-retros.py --run-ids <id1> <id2> ...

# Preview without calling the gateway:
python3 scripts/bulk-resolve-retros.py --dry-run --all-pending
```

Each call sends `run.resolveDecision` over WS via `apps/command-center/scripts/cdp.mjs gateway` with `actionId:'dismiss'` (the closest existing action — see _Known limitation_ below). The gateway atomically sets `resolvedAt`/`resolvedAction` on the decision and emits `RUN_DECISION_RESOLVED` so the UI quiets immediately. Refuses to run if `http://localhost:7777/health` is unreachable.

The audit log records every resolved run id + decision id + flow + project, plus the `--reason` string — stamped UTC so future archaeology can trace bulk passes back to the LEARNINGS entries that consumed them.

## Known limitation — `dismiss` is the wrong label

Today the script uses `actionId:'dismiss'` because it's the only no-op resolution the gateway accepts (`accept` would fire `improvement-engine.analyzeAndPropose()` per retro — exactly what bulk processing replaces). Semantically, "dismiss" reads like "this retro was noise"; what we mean is "consolidated into LEARNINGS, do not reanalyze".

A small follow-up to the gateway would add a distinct `'batch-extracted'` resolved action:

1. Allow the value in `RunResolveDecisionParams.actionId` (`packages/protocol`).
2. Branch in `runResolveDecision` (`services/gateway/src/methods/run.ts`) to skip `improvement-engine` even on non-`dismiss` actions.
3. Surface in analytics/UI as a 3rd state distinct from `accept` and `dismiss`.

Until that lands, treat the dismiss + audit log as the source of truth for "batch-extracted" runs.

## Invariants

- Gateway must be up for Pass 3. Pass 1 + Pass 2 work offline.
- Pass 2 is human-driven curation. Refuse to auto-write to `LEARNINGS.md`.
- Audit log appends — never overwrite. Multiple passes per day stack inside the same date file.
- Conventional Commits: any LEARNINGS update or template edit should land under `docs(learnings):` or `chore(templates):` per `farmslot/CLAUDE.md`.

## See also

- `scripts/extract-pending-retros.py` — Pass 1 implementation.
- `scripts/bulk-resolve-retros.py` — Pass 3 implementation.
- `services/gateway/src/run-completion/orchestrator.ts::createRetrospective()` — where retros are produced.
- `services/gateway/src/methods/run.ts::runResolveDecision()` — the WS handler this skill drives.
- `services/gateway/src/improvement-engine.ts::analyzeAndPropose()` — what `accept` triggers; bulk path skips this.
