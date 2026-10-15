---
title: Make your project Farmslot-compatible
---

# Make your project Farmslot-compatible

Build a headless project with one action, a recipe that proves its effect, and a checked teardown. Then dispatch it through Farmslot. This tutorial supports the [recipe contracts](../reference/recipe-concepts.md); its runnable source is the [example-app pack](https://github.com/deeeed/farmslot/tree/main/packs/example-app). Keep the tutorial and pack together when changing the contracts.

Use a Farmslot checkout with dependencies installed and these CLI commands available. The shell examples run its local binary. Git and Node.js are required. The sample creates only disposable files and a tiny local product repository.

## 1. Declare an empty pack

From the Farmslot repository root:

```sh
FARMSLOT_SRC="$PWD"
tutorial_root="$(mktemp -d)"
tutorial_pack="$tutorial_root/pack"
tutorial_project="$tutorial_pack/projects/example-app-farm"
mkdir -p "$tutorial_project"
cp packs/example-app/pack.json "$tutorial_pack/"
cp -R packs/example-app/hooks "$tutorial_pack/"
cp packs/example-app/projects/example-app-farm/project.json "$tutorial_project/"
cp -R packs/example-app/projects/example-app-farm/setup "$tutorial_project/"
cp -R packs/example-app/projects/example-app-farm/fixtures "$tutorial_project/"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$tutorial_project/project.json"
```

`pack.json` describes installation and slot creation. `project.json` declares behavior. The complete example declaration points to the provider, recipes and task templates added below. A pool supplies the machine, checkout, ports and device bindings; keep those values out of the pack.

This step establishes the declaration. Registration happens in step 6.

## 2. Add a ProjectRuntime and its action

```sh
cp packs/example-app/projects/example-app-farm/provider.mjs "$tutorial_project/"
cp -R packs/example-app/projects/example-app-farm/manifests "$tutorial_project/"
node --check "$tutorial_project/provider.mjs"
```

The module exports `createProvider(context)` and returns `{ runtime, cancel, finalize }`. Its ActionCatalog pairs the strict `example.note` manifest with an ActionHandler. The handler creates, observes or removes one note. Exclusive creation preserves an existing file; cleanup removes only a note owned by this provider session.

The runtime is headless. It needs no server, device, overlay or HUD. It supplies readiness and refuses app launch explicitly. The default RecipeEngine handles preflight, execution and artifacts; the provider implements no graph executor.

## 3. Add the bundled recipe library

```sh
cp packs/example-app/projects/example-app-farm/recipe-library.json "$tutorial_project/"
cp -R packs/example-app/projects/example-app-farm/recipes "$tutorial_project/"
FARMSLOT_REPOS_DIR="$tutorial_root/repos" bash "$tutorial_pack/hooks/pre-add.sh"
sample_checkout="$tutorial_root/repos/example-app-src"
node "$FARMSLOT_SRC/packages/cli/bin/farmslot.mjs" recipe actions \
  --projects-dir "$tutorial_pack/projects" --project example-app-farm --target "$sample_checkout" \
  --action example.note
```

The library travels with this provider. The `smoke` recipe creates a note, reads it back and asserts the value. Its authored teardown removes the note and asserts its absence. Assertions name the `note` and `cleanup` proof targets.

For independently released team libraries, use the ordered `recipe.libraries` declaration described in [Recipe concepts](../reference/recipe-concepts.md). Each repository source needs an exact revision and owner. A provider's bundled library uses the provider's own identity; do not put a self-referential Git revision in its declaration.

## 4. Check and run the recipe

```sh
node "$FARMSLOT_SRC/packages/cli/bin/farmslot.mjs" doctor "$sample_checkout" --conformance \
  --projects-dir "$tutorial_pack/projects" --project example-app-farm --recipe smoke
node "$FARMSLOT_SRC/packages/cli/bin/farmslot.mjs" recipe call example.note operation=observe \
  --projects-dir "$tutorial_pack/projects" --project example-app-farm --target "$sample_checkout"
node "$FARMSLOT_SRC/packages/cli/bin/farmslot.mjs" recipe run smoke \
  --projects-dir "$tutorial_pack/projects" --project example-app-farm --target "$sample_checkout"
```

Conformance checks dependencies, parameters, handler coverage and authorization without executing actions. A manifest entry without a handler fails. The observation call leaves the checkout unchanged. The run executes the graph and returns its artifact paths.

## 5. Retain live proof

```sh
node "$FARMSLOT_SRC/packages/cli/bin/farmslot.mjs" doctor "$sample_checkout" --conformance --live \
  --projects-dir "$tutorial_pack/projects" --project example-app-farm --recipe smoke \
  --disposable --smoke-target note --teardown-target cleanup
node "$FARMSLOT_SRC/packages/cli/bin/farmslot.mjs" doctor "$sample_checkout" --conformance \
  --projects-dir "$tutorial_pack/projects" --project example-app-farm --recipe smoke \
  --check-report "$sample_checkout/.agent/artifacts/conformance/conformance-report.json"
```

The live check must observe both the file value and its removal. It retains the trace, recipe resolution, summary and artifact manifest. The second command verifies the saved identities and artifact bytes without another execution. Changing the provider, library, checkout, target or retained evidence invalidates reuse.

A pooled live check additionally needs `--run <id>` naming the existing run that owns the selected target. It observes gateway leases and aborts if ownership is lost. `--disposable` grants no lease or funding authority.

## 6. Register and dispatch

```sh
cp -R "$FARMSLOT_SRC/packs/example-app/projects/example-app-farm/templates" "$tutorial_project/"
cp -R "$FARMSLOT_SRC/packs/example-app/projects/example-app-farm/scripts" "$tutorial_project/"
```

Initialize a disposable workspace through the normal [installer](getting-started.generated.md). Keep its machine state separate and choose an unused gateway port:

```sh
unset FARMSLOT_ROOT FARMSLOT_POOL_DIR
export FARMSLOT_WORKSPACE="$tutorial_root/workspace"
export FARMSLOT_HOME="$tutorial_root/home"
export FARMSLOT_BIN_DIR="$tutorial_root/bin"
FARMSLOT_MINIMAL=1 FARMSLOT_SKIP_CAPTURE_HELPER=1 FARMSLOT_NO_STAR_PROMPT=1 \
  bash "$FARMSLOT_SRC/install.sh"
export FARMSLOT_ROOT="$FARMSLOT_WORKSPACE/farmslot"
export FARMSLOT_POOL_DIR="$FARMSLOT_ROOT/pool"
tutorial_cli="$FARMSLOT_ROOT/packages/cli/bin/farmslot.mjs"
node "$tutorial_cli" up --port 17877 --no-open --no-node
tutorial_machine="$(node -p 'require("node:os").hostname().replace(/\.local$/, "")')"
node "$tutorial_cli" --gateway local credential issue \
  --principal "$tutorial_machine" --subject node --machine "$tutorial_machine" \
  --secret-file "$FARMSLOT_HOME/node.secret" --json
node "$tutorial_cli" up --port 17877 --no-open
node "$tutorial_cli" --gateway local gateway status
```

Use the installed CLI for the rest of this section so the gateway, node and registered pack use the same disposable workspace. The first `up` starts only the gateway and records the authenticated `local` profile. Issue its local node credential once, then run `up` again to start the node. `--secret-file` stores the credential in the disposable gateway home with mode 0600; `--json` returns credential metadata without printing the secret. `FARMSLOT_WORKSPACE` selects installation files; it does not select the gateway for RPC calls. Use `--gateway local` below, and confirm the installer reports the disposable workspace and gateway status reports the chosen port and connected local node. If port 17877 is occupied, choose another unused port.

Register the pack and create a run:

```sh
node "$tutorial_cli" project add "$tutorial_pack"
node "$tutorial_cli" --gateway local fleet status --force-refresh
node "$tutorial_cli" --gateway local run create \
  --project example-app-farm --flow-type qa --qa-profile smoke \
  --ticket "Example recipe smoke" --mode validation \
  --runner scripted --scripted-command-ref recipe-smoke --json > "$tutorial_root/run.json"
run_id="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).data.run.id' "$tutorial_root/run.json")"
node "$tutorial_cli" --gateway local run get "$run_id"
```

Confirm the refreshed fleet lists the new `example-app` slot as ready before creating the run. `fleet status --force-refresh` probes the newly registered pool instead of returning the earlier empty snapshot.

The `smoke` QA preset selects `qa/recipe-smoke`. Its frontmatter declares `recipe_checks: [smoke]` and `recipe_actions: [example.note]`. Preview checks that selected flow; dispatch rechecks after prepare. The declared scripted command runs the real recipe and writes the usual run signal and command artifacts. The sample declares those outputs in `worker_terminal.flows.qa.complete`: the command report, result, stdout, executable provenance and `qa-result.json` are required. The wrapper uses the shared suite writer to bind the admitted QA inputs and prepared revision to the actual recipe package. The result must succeed and its retained recipe trace must show both assertions. Use `run get` to verify that `monitor.outputs.qaEvidence` contains the checked package and that the run completes successfully. This QA flow uses `artifact-only` completion: the QA evidence gate must pass, the publication `human-gate` step records `skipped: true`, and a `Review run output` decision retains the evidence for inspection. Check the scripted command result and retained recipe trace for both assertions. Command Center can inspect the same run on this gateway.

In Dispatch, **Check selected flow** shows registration, missing requirements and the last checked revision and target. `recipe-verified` requires current live evidence for that exact scope. The separate slot checkout does not inherit the standalone checkout's proof. A static review has no automatic runtime or HUD requirement.

Optional template fields are `recipe_capture`, `recipe_hud` and `runtime_capabilities`. Declare only what the selected flow needs. Capture and resource support are declarations; a passing headless smoke does not prove a UI target.

## Apply the pattern to your project

Replace the example handler with a project operation and an observable postcondition. Keep launch, cancellation and owned cleanup in the provider. Put reusable graphs in team libraries, and task-specific proof beside the task. Run the same static and live checks on each claimed target, then one actual dispatch. Use the [generated CLI reference](../reference/recipe-cli.md) for the current flags.
