# @farmslot/skills

Generic Farmslot recipe skills for Claude, Codex, Cursor, and repo-local agent skill folders.

Public guide: https://farmslot.io/docs/guides/recipe-skills-adoption

## What This Package Is

`@farmslot/skills` is the recipe-first adoption kit. It teaches an agent how to write, review, diagnose, and adopt validation recipes before a team installs the full Farmslot framework.

It does not require Gateway, Command Center, a pool file, slots, or Companion for first use.

## Install

Install all skills into a repo-local generic agent folder:

```bash
npx @farmslot/skills install --target . --layout agents
```

Install a subset:

```bash
npx @farmslot/skills install --target . --layout agents --include recipe-cook,recipe-doctor
```

Supported layouts:

| Layout   | Destination under `--target` |
| -------- | ---------------------------- |
| `agents` | `.agents/skills/`            |
| `codex`  | `.codex/skills/`             |
| `claude` | `.claude/skills/`            |
| `cursor` | `.cursor/skills/`            |

## Skills

| Skill            | Purpose                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `recipe-cook`    | Turn acceptance criteria, PR intent, or investigation findings into a validation recipe.        |
| `recipe-quality` | Critique recipe and evidence quality; flag fake proof, hidden state injection, and weak claims. |
| `recipe-doctor`  | Check local readiness for recipe authoring or execution.                                        |
| `recipe-harness` | Help install or run the local recipe runtime when the project has one.                          |
| `project-adopt`  | Recommend the smallest useful Farmslot integration level for the project.                       |
| `packet`         | Communicate plans, blockers, decisions, and evidence reviews as compact operator packets.       |

## Checklist-shaped skills

A checklist step can hand its work to a skill as a **child unit**: the step registers the
skill, `mark` materializes its body as `subtasks/<id>.md` beside the task checklist, and the
worker marks the skill's own rows so progress is visible per row instead of one box open for
the whole review. Farmslot only materializes and observes files; nothing is spawned.

A skill can be a child unit when its body is enumerable by the same parser the task checklist
uses:

- `##` (or deeper) headings and `- [ ]` rows, with at least one row. A prose-only skill cannot be
  a child unit.
- Name informational sections so the shared skip list drops them: `Rules`, `Description`,
  `Task`, `Acceptance Criteria`, `Affected Area`, `Screenshots`, `Comments`, `Root Cause`,
  `Recipe ACs`, `Pre-merge`. Boxes there are never steps.
- If a row label carries its own number (`**3. …**`), it must match the row's position. The
  numbering guard refuses a body where they diverge, because `mark` targets positions.

A template step registers the installed skill and finishes it:

```bash
{{TASK_DIR}}/mark sub start perps-review --step 21 --from .agents/skills/mms-perps-review-pr/skill.md
{{TASK_DIR}}/mark sub perps-review 1        # …one per row
{{TASK_DIR}}/mark sub perps-review complete --report artifacts/review.md
```

The step's own box is ticked by that `complete`, so the template says what to register, and the
skill owns what to check.

## Adoption Ladder

1. Skills only: author and review recipes without a runner.
2. Recipe runner: add a local command that can execute one recipe and emit artifacts.
3. Project recipe layer: add recipes, runner manifests, project actions, and artifact conventions.
4. Farmslot project integration: add `project.json` hooks for Command Center and slots.
5. Full framework: adopt multi-slot dispatch, live steering, Companion supervision, and retrospectives.

## Source layout

- `src/`: TypeScript CLI and install-library entry points.
- `skills/`: Packaged skill directories copied into consumer repos.
- `scripts/`: Compatibility shims for legacy runtime paths. Runtime logic lives in `@farmslot/agent-runtime`.
- `templates/`: Scenario fixtures and task templates used by the recipe-cook workflow.
- `test/`: Node TAP-style smoke and behavior tests for installers and runner scripts.

## Maintenance rules

- `scripts/mark-checklist-step.cjs`, `scripts/worker-terminal-contract.cjs`, and `scripts/check-task-artifact-contract.mjs` are compatibility shims that delegate to `@farmslot/agent-runtime`.
- Keep package payloads self-contained; consumers should not need the Farmslot monorepo.
- Update `CHANGELOG.md` before packaging or publishing.
- Run the package readiness guard when files move, bins change, or exports are added.

## Local quality

```bash
yarn workspace @farmslot/skills build
yarn workspace @farmslot/skills test
node scripts/quality/check-farmslot-package-readiness.mjs --packages @farmslot/skills
```

## License

MIT. See [LICENSE](LICENSE).
