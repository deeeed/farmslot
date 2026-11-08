# @farmslot/agent-runtime

Live agent task lifecycle tools for Farmslot-compatible runs.

Public reference: https://farmslot.io/docs/reference/agent-runtime

This package owns the reusable task-dir runtime surface:

- `mark` and checklist timing updates;
- worker-owned `SIGNAL.json` writes;
- worker terminal contract resolution and linting;
- closeout artifact checks;
- `recipe-quality.json` builder/generator for worker-authored quality artifacts.

It does not execute recipes. Recipe graph execution belongs in
`@farmslot/recipe-runner`, and schemas/validators belong in `@farmslot/protocol`.

## CLI

```bash
farmslot-agent task init <task-dir> --flow fix-bug --platform mobile --template fix-bug/autonomous.mobile --package-templates <catalog> --title "…" --task-text "…" [--run-mode <mode>]
farmslot-agent mark <task-dir> complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
farmslot-agent recipe-quality feedback --task <task-dir> --json
farmslot-agent contract resolve --flow fix-bug
```

## Compatibility

Legacy script paths in `@farmslot/skills` and `scripts/quality/` delegate here
for one migration window. New integrations should call `farmslot-agent`, install
a task-local `./mark` shim, or import the explicit script subpaths.

## Source layout

- `bin/`: CLI entry point for task-local helper installation, marking, artifact checks, and terminal contract resolution.
- `scripts/`: Runtime scripts that can be called directly by task files and compatibility shims.
- `src/`: Public package constants and typed runtime helpers such as `buildRecipeQualityArtifact()`.
- `test/`: Node TAP-style behavior tests for package exports, checklist marking, and artifact contract checks.

## Maintenance rules

- Keep runtime behavior here, not in `@farmslot/skills`; skills should teach and install, then delegate.
- Keep protocol schemas and pure validators in `@farmslot/protocol`; this package may consume them but should not own them.
- Preserve script subpath exports while task templates, remote slots, and compatibility shims depend on direct script paths.
- Update package readiness, CI filters, docs, and `CHANGELOG.md` when adding bins, exports, or required artifacts.

## Local quality

```bash
yarn workspace @farmslot/agent-runtime build
yarn workspace @farmslot/agent-runtime test
node scripts/quality/check-farmslot-package-readiness.mjs --packages @farmslot/agent-runtime
```

## License

MIT. See [LICENSE](LICENSE).

### Farm proof-shape feedback

Farm-generated recipe-writing tasks opt into a pre-completion advisory step. The
installed helper reads the bound recipe, registered worker criteria and declared
libraries, then prints short/composed/parameterized scores and exact fix hints.
Threshold warnings exit successfully. The helper adds optional `shape` feedback
to `artifacts/recipe-quality.json` and keeps its catalog in the separate
`artifacts/recipe-shape-catalog.json`; existing core fields remain unchanged.
The gateway verifies/recomputes fresh shape inputs independently of its core
structural grade. A worker-supplied catalog is self-consistent, not certified
complete. Review-only/non-local obligations never become local proof by scoring.

`RECIPE_QUALITY_FEEDBACK_CMD` resolves from retained task tooling and is available
for project overrides under the existing task-command rules. Only Farm generation
sets the managed opt-in; standalone/org skill behavior and library-owned checklist
bytes are unchanged. This helper runs no recipe, build, test or model request.
