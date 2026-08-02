---
name: fs-backlog-spec
description: Author or review a Farmslot backlog spec (.backlog/specs/**) — run deterministic spec-lint, check AC↔scope traceability and code refs, then file via backlog.create with the spec attached and verify the round-trip. For agents filing work the farm will later dispatch.
---

# FS Backlog Spec

A spec under `.backlog/specs/` becomes a worker's contract: every acceptance criterion must be verifiable by the worker/reviewer inside one run. The gateway parses the `## Acceptance Criteria` section verbatim (`extractBacklogAcceptanceCriteria` in `services/gateway/src/backlog/spec.ts`), so write one criterion per line — a wrapped line becomes a second criterion when filed.

## Step 1 — Deterministic lint (required)

```bash
node .agents/skills/fs-backlog-spec/spec-lint.mjs .backlog/specs/<spec>.md
```

Hard rules (one `<file>:<line>: <rule>: <excerpt>` per violation, exit 1): `## Acceptance Criteria` present with criteria that parse under the gateway's rules; every criterion carries a concrete check marker (inline-code command/test/grep/file ref, or an explicit `artifact:` / `recipe:` ref); no operator- or time-dependent acceptance (`after merge`, `post-merge`, `N-day`, `operator enables`, `monitoring for/over`, `soak`); `## Non-goals` present and non-empty. Fix the spec — never reword to dodge a pattern without adding a real proof.

`--print-ac` prints the criteria exactly as the gateway will parse them. Self-test: `yarn node --test ".agents/skills/fs-backlog-spec/*.test.mjs"`.

## Step 2 — Heuristic review

- **Traceability** — every Deliverable maps to ≥1 criterion and every criterion back to a Deliverable; orphans mean padding or missing proof.
- **Verified refs** — grep every file path/symbol/flag the spec names against current source before writing it; stale refs send workers hunting ghosts.
- **Proof surface** — name the target project's surface inside the criterion: farmslot-farm proves via gateway tests / runner-validation harness / CDP recipe; other projects via their recipe runner.
- **Downstream gates** — express follow-up-item gates as file + JSON field checks (e.g. `artifact:` paths, flag defaults in `project.json`), never prose conditions.
- **Right-size** — split anything a worker cannot finish in one run into ordered items, each with its own AC block.

## Step 3 — File it and verify the round-trip

```bash
cd apps/command-center
yarn farmslot backlog create --project <project> --title "<spec title>" \
  --flow-type <fix-bug|dev> --spec .backlog/specs/<spec>.md   # omit sourceRef — gateway auto-numbers MANUAL-NNN
yarn farmslot backlog get <MANUAL-NNN> --spec
```

Confirm the round-trip: `backlog get <ref> --spec` (RPC `backlog.spec.get`) returns the stored spec content — run `spec-lint --print-ac` on it and the criteria count must equal `spec-lint --print-ac <spec>.md | wc -l` from the file you authored. A mismatch means the file drifted after linting — fix and re-verify before calling the item filed.

## Out of scope

- Gateway/protocol validation changes (gateway keeps its minimal non-empty-AC check)
- Dispatch/monitor-time enforcement; grading finished runs (family retrospective)
- Worker prompt templates (`fs-worker-template-quality`)

## Related

- Lint + fixtures + tests: `.agents/skills/fs-backlog-spec/`
- Gateway parser: `extractBacklogAcceptanceCriteria` — `services/gateway/src/backlog/spec.ts`
- Reference pattern: `.agents/skills/fs-worker-template-quality/SKILL.md`
