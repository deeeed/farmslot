# Changelog

## Unreleased

### Added

- Add `buildRecipeQualityArtifact()` and `farmslot-agent recipe-quality build` so agents can generate validator-compliant `recipe-quality.json` artifacts from compact verdict/reason/finding inputs.
- Introduce `@farmslot/agent-runtime` for task-local `mark`, `SIGNAL.json`, worker terminal contract, and task artifact checks.
- Add `farmslot-agent` CLI with `mark`, `artifact-check`, `install-mark`, and `contract resolve` commands.
