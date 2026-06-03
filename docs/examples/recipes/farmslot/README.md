# Farmslot self-validation recipe fixtures

These v1 recipe fixtures dogfood the Generic Recipe Protocol against Farmslot's
own surfaces. They are intentionally runner-neutral: each recipe uses the shared
`validate.workflow` envelope and adapter-owned action names, then pairs that
recipe with a sample artifact package shaped like a completed project run.

The matching action catalog example is
`../farmslot-v1.action-manifest.json`. It declares the official actions and
precondition IDs these fixtures use.

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

Validate every fixture from the repository root with:

```bash
cd apps/command-center
for recipe in ../../docs/examples/recipes/farmslot/*.recipe.json; do
  name=$(basename "$recipe" .recipe.json)
  yarn farmslot recipe validate "$recipe" --artifact-dir "../../docs/examples/recipes/farmslot/artifacts/$name"
done
```

A real Farmslot runner may replace these fixture artifacts with live outputs, but
it should keep the same minimum package shape: `summary.json`, `trace.json`,
`artifact-manifest.json`, and a resolved `recipe.json` or `workflow.json` when
practical.
