# Wrapper retention control

Run after building the workspace for release or rollout:

```bash
TSX_TSCONFIG_PATH=packages/recipe-cli/tsconfig.json node --import tsx --test packages/recipe-cli/test/live/recipe-artifact-rerun.test.mts
```

This exercises two wrapper executions, the engine manifest contract and retained
bytes. It took 5.9 seconds on the validation host, so it is outside default CI.
The fast artifact checker and producer tests cover selection and manifest shape.

## Separate task and application target

```bash
node --import tsx packages/recipe-cli/test/live/recipe-task-context.test.mts
```

Uses disposable project/provider/task fixtures with the real CLI and engine. Checks
both acceptance artifacts, explicit provider selection, retained receipts and a
provider action with explicit output storage. No device or existing farm run changes.
