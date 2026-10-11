# Farmslot self-validation recipe fixtures

These v1 recipe fixtures exercise the Generic Recipe Protocol against Farmslot's
own surfaces. They are intentionally runner-neutral: each recipe uses the shared
`workflow` graph and adapter-owned action names, then pairs that
recipe with a sample artifact package shaped like a completed project run.

The matching action catalog example is
`../farmslot-v1.action-manifest.json`. It declares the official actions and
strict action contracts these fixtures use.

The suite covers:

- Command Center web UI: recipe graph, replay controls, artifact viewer, and
  ready/review workspace basics.
- Gateway RPC/API: recipe-run RPCs, artifact index ingestion, run/family
  projection, and manifest validation.
- Runner provenance: consistent summary, trace metadata, and typed manifest
  provenance for strict runtime artifact gates.
- Mobile Companion: run detail, decision/evidence review, recipe-run selection,
  artifact cards, and media viewing.
- Live recipe player: warm-slot replay, visible stream/logs, and generated
  output artifacts.
- Documentation/onboarding: v1 contract validation for examples and fixtures.

Validate available retained fixtures from the repository root with:

```bash
cd apps/command-center
for recipe in ../../docs/examples/recipes/farmslot/*.recipe.json; do
  name=$(basename "$recipe" .recipe.json)
  artifacts="../../docs/examples/recipes/farmslot/artifacts/$name"
  if [ -f "$artifacts/recipe.json" ]; then
    yarn farmslot recipe validate "$artifacts/recipe.json" --artifact-dir "$artifacts"
  fi
done
```

This checks each retained recipe snapshot against its original evidence.
Shortening authored intent does not rewrite those artifacts. Recipes without a
retained fixture need their declared inputs when validating current authoring.
For example, `yarn farmslot recipe validate ../../docs/examples/recipes/farmslot/gateway-rpc-api.recipe.json`
checks the current gateway recipe's intent lengths.

A real Farmslot runner may replace these fixture artifacts with live outputs, but
it should keep the same package shape: `summary.json`, `trace.json`,
`artifact-manifest.json`, `recipe.json`, `recipe-resolution.json`, and any
digest-keyed dependency recipes.
