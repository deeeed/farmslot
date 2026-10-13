# Wrapper retention control

Run after building the workspace for release or rollout:

```bash
TSX_TSCONFIG_PATH=packages/recipe-cli/tsconfig.json node --import tsx --test packages/recipe-cli/test/live/recipe-artifact-rerun.test.mts
```

This exercises two wrapper executions, the engine manifest contract and retained
bytes. It took 9.6 seconds on the validation host, so it is outside default CI.
The fast artifact checker and producer tests cover selection and manifest shape.
