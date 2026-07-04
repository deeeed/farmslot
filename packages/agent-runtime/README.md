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
`@farmslot/recipe-harness`, and schemas/validators belong in `@farmslot/protocol`.

## CLI

```bash
farmslot-agent install-mark <task-dir> --task TASK.md --signal SIGNAL.json
farmslot-agent mark <task-md> <signal-json> complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
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
