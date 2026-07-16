---
name: fs-backlog-spec
description: Author or review a Farmslot backlog spec (.backlog/specs/**) — run deterministic spec-lint, then check AC↔scope traceability, verified code refs, and the backlog.create round-trip. For agents filing work the farm will later dispatch.
---

# FS Backlog Spec

Authoring tool for backlog spec files under `.backlog/specs/<project>/`. A spec written here becomes a worker's contract — every acceptance criterion must be checkable by the worker and its reviewer inside one run, with no operator eyeballs and no wall-clock waits.

## Step 1 — Deterministic lint (required)

```bash
node .agents/skills/fs-backlog-spec/spec-lint.mjs .backlog/specs/<project>/<spec>.md
```

Hard-fails on: missing title / `**Project:**` / Problem / Deliverables / `## Acceptance Criteria`; AC bullets without a concrete check marker (test, backticked command/path, typecheck, CDP, recipe); operator-dependent or time-dependent acceptance ("manually verify", "operator confirms", "wait 10 minutes", "after the soak", "looks right").

Fix lint failures before the heuristic pass. Do not reword a criterion to dodge a pattern — replace it with a real proof.

## Step 2 — Heuristic review

- **AC ↔ scope traceability** — every Deliverable maps to ≥1 acceptance criterion; every criterion traces back to a Deliverable. Orphans on either side mean the spec is padded or under-proven.
- **Verified code refs** — every file path, symbol, or config key the spec names must exist NOW: grep the repo before writing it down. A spec that names `services/gateway/src/foo.ts` unverified sends a worker hunting a ghost.
- **Project proof surface** — say WHERE proof lives for this project: gateway/protocol changes prove via `node scripts/quality/run-tsx-tests.mjs` suites + `yarn typecheck`; UI changes prove via CDP against the live dashboard; recipe-facing changes prove via a recipe run. Name the surface in the AC, not just "tests".
- **Right-size** — a spec a worker cannot finish in one run should be split into ordered items, each with its own AC block.

## Step 3 — backlog.create round-trip

File the item so the spec and the backlog agree:

```bash
cd apps/command-center && yarn farmslot backlog create \
  --project <project> --title "<spec title>" --flow-type <fix-bug|dev> \
  --notes "Spec: .backlog/specs/<project>/<file>.md — <one-line scope>"
```

Then re-read the created item (`yarn farmslot backlog show <ref>`) and confirm title, flow type, and the spec path in notes match the file. The spec is not "filed" until the round-trip is verified.

## Out of scope

- Enforcing spec quality at dispatch/monitor time (workers get TASK.md, not the raw spec)
- Grading finished runs (family retrospective owns that)
- Worker prompt templates (use `fs-worker-template-quality`)

## Related

- Lint: `.agents/skills/fs-backlog-spec/spec-lint.mjs`
- Reference pattern: `.agents/skills/fs-worker-template-quality/SKILL.md`
- Specs live in `.backlog/specs/<project>/`; items reference them from `notes`
