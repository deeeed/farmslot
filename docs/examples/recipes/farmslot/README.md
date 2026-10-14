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

## Identity and credential proof

`identity-credentials.recipe.json` starts disposable service and node identities,
checks RPC/HTTP authorization and retirement, then drives the browser login form.
It needs Node 22, installed workspace dependencies and an agent-owned Chrome CDP
endpoint selected by `FARMSLOT_CDP_PORT`. It does not change a live farm.

From the checkout root, select the standard command actions from the shared
catalog and run the recipe through the local CLI:

```sh
mkdir -p temp
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const catalog = JSON.parse(readFileSync("docs/examples/recipes/farmslot-v1.action-manifest.json", "utf8"));
  catalog.actions = Object.fromEntries(["command", "end"].map(name => [name, catalog.actions[name]]));
  delete catalog.observers;
  writeFileSync("temp/identity-command.action-manifest.json", JSON.stringify(catalog));
'
node packages/cli/bin/farmslot.mjs --json recipe run \
  docs/examples/recipes/farmslot/identity-credentials.recipe.json \
  --project-root . --action-manifest temp/identity-command.action-manifest.json \
  --artifacts-dir temp/identity-credentials-proof
```

Both scripts own their child processes and temporary state. Browser screenshots
are written by the startup proof; the CLI retains command output and the recipe
artifact package.
