---
title: Recipe discovery
---

# Recipe discovery

`farmslot-recipe` (package `@farmslot/recipe-cli`) can tell you what your recipe libraries offer before you run anything: which actions exist and what parameters they take, which recipes exist on which platforms, and what a recipe will call. Discovery reads libraries from disk. It needs no app, device, target or platform adapter.

## Quickstart

The repository ships a tiny library at `examples/recipe-library-hello`. From a Farmslot checkout:

```sh
yarn install
yarn workspace @farmslot/recipe-cli build
export RECIPE_LIBRARY_PATH="hello=$PWD/examples/recipe-library-hello"
alias farmslot-recipe="$PWD/node_modules/.bin/farmslot-recipe"
```

In your own project, install `@farmslot/recipe-cli` and point `RECIPE_LIBRARY_PATH` at your library instead.

**1. List the recipes.**

```console
$ farmslot-recipe list
Recipes (all platforms: web) (2)
  greet  [hello · recipes/greet.recipe.json] runnable
    Print a greeting for one name and prove it was printed.
    variants: generic, web
  greet-twice  [hello · recipes/greet-twice.recipe.json] runnable
    Compose greet twice: once for the guest passed in, once for a fixed host.
```

**2. See which actions recipes can use.**

```console
$ farmslot-recipe actions --platform web
  assert_output  [hello · shared] handler=builtin fields=source,stream,contains,match
  command  [hello · shared] handler=builtin fields=cmd,timeout_ms,cwd,allow_failure risk=host-exec
  hello.wave  [hello · web] handler=adapter fields=name risk=app-mutation
  ...
```

`handler=builtin` actions run in `farmslot-recipe` itself. `handler=adapter` actions are declared by the library and run by a platform adapter, which discovery does not need.

**3. Describe one recipe.**

```console
$ farmslot-recipe describe greet
recipe greet — Greet someone
  id: hello.greet (resolved by ref)
  variants: generic (hello), web (hello)
  parameters (1):
    name (string) default="world" — Who to greet.
  callers (1):
    greet-twice
```

**4. Explain what a recipe will do, with your parameters.**

```console
$ farmslot-recipe explain greet-twice --param guest=Ada
  greet-twice [hello · recipes/greet-twice.recipe.json]
    param guest = "Ada" (input)
    #greet-guest call greet
      greet [hello · recipes/greet.recipe.json]
        param name = "Ada" (input ← {{params.guest}})
        #say command
        #check assert_output
    #greet-host call greet
      ...
Required actions (3): assert_output, command, end
Capabilities: host-exec
Missing: none
```

`explain greet --platform web` selects the web variant and reports `hello.wave` as handled by a platform adapter that is not loaded.

**5. Run it.** Library recipes have unknown trust, so a recipe that runs shell commands stops at the plan and prints the digest to approve:

```sh
farmslot-recipe run greet-twice guest=Ada \
  --action-manifest examples/recipe-library-hello/manifests/shared.action-manifest.json \
  --artifacts-dir /tmp/hello-run
# review the plan, then rerun with --approve-plan <digest>
# repeated runs through the same command (here `farmslot-recipe run`) ask for the same
# digest; see Recipe Runner Protocol for what the approved environment covers
```

## Libraries and precedence

A library is a directory with `recipes/`, optional `manifests/`, and an optional `recipe-library.json`.

| source                                | origin    |
| ------------------------------------- | --------- |
| `--library name=path` (repeatable)    | `flag`    |
| `RECIPE_LIBRARY_PATH=name=path:…`     | `env`     |
| `$FARMSLOT_HOME/recipe-library` alone | `default` |

- Libraries are searched in rank order: `--library` entries first, then `RECIPE_LIBRARY_PATH`. The personal library is used only when neither is set.
- A `--library` entry replaces the `RECIPE_LIBRARY_PATH` entry with the same name, and the output records what it overrode.
- The first library that declares a recipe ref or an action wins. Lower-ranked libraries that declare it too are listed as `shadows`.
- Within one library, a platform variant (`recipes/<platform>/…`) wins over the generic recipe, and `manifests/<platform>.action-manifest.json` wins over `manifests/shared.action-manifest.json`.
- Every recipe also has a namespaced id, `<library>.<ref>`. `run`, `describe` and `explain` accept it and select that library's recipe even when another library shadows it. With `--platform`, a qualified alias such as `web.greet` works the same way in `run --adapter web` and in discovery. A ref with the same name as an id wins.
- Call nodes inside recipes still resolve refs by precedence, so `template` refuses a shadowed id (`RECIPE_SHADOWED`) instead of emitting a node that would call the winner.
- Commands that discovery prints (`runCommand`) repeat the name as given, your `--library` entries and the platform, so they resolve the same recipe.

Library files are read and digested by one walker. It covers `recipes/`, `manifests/` and `actions/`, skips dot-entries, `node_modules` and symlinked directories, and rejects any file (symlinked or not) that resolves outside the library root. The library's content digest covers those files plus `recipe-library.json` and the files it declares. Text files hash with LF line endings, so a CRLF checkout has the same digest. Discovery prints the digest, and `run` records it in the run summary's library provenance. When `run` selects a recipe by name, `summary.json` records `recipeSelection` (`name`, `resolvedBy`, `source`, `file`, `path`), and the run log names the selected recipe instead of warning about a winner it did not run.

### `recipe-library.json`

Every key is optional.

```json
{
  "platforms": ["web"],
  "actions": { "shared": "manifests/shared.action-manifest.json" },
  "adapters": {
    "web": { "module": "./plugins/web.mjs", "export": "webAdapter", "extends": "browser" }
  },
  "requires": { "@farmslot/recipe-runner": ">=0.21.1" }
}
```

| key         | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platforms` | Platform folders under `recipes/`. `core`, `extension` and `mobile` are always recognized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `actions`   | Action manifest per platform or `shared`. Defaults to `manifests/<scope>.action-manifest.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `adapters`  | Platform adapter modules the library ships. Discovery validates and digests them but does not load code yet.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `requires`  | Package version ranges, checked every time the library loads (`run`, `validate` and discovery). It fails closed: an out-of-range version, or a package the host cannot check, fails with `RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED`. Every host provides `@farmslot/recipe-runner`, so require that. `farmslot-recipe` also provides `@farmslot/recipe-cli` and `@farmslot/expo-recipe` hosts provide `@farmslot/expo-recipe`; requiring either limits the library to that host (`farmslot recipe` and the Command Center runner provide only the harness). |

Declared paths must be regular files inside the library root. Invalid content fails with `RECIPE_LIBRARY_MANIFEST_INVALID`.

## Commands

Every command accepts `--library name=path` (repeatable), `--platform <id>` and `--json`.

| command                                     | answers                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions [--source lib]`                    | Every action the libraries declare, plus the handlers this CLI registers: owner, scopes, parameters, capabilities, handler.                                                                                                                                                                                                                         |
| `list [--source lib] [--runnable]`          | Recipes with ref, id, source, variants and shadows, and whether each validates against the declared actions in this view.                                                                                                                                                                                                                           |
| `describe <name> [--kind k]`                | A recipe's parameters, variants, transitive actions and calls, callers and a run command; or an action's schema, examples, result cases and callers.                                                                                                                                                                                                |
| `explain <recipe> [--param k=v] [--strict]` | The resolved call tree with parameter flow, required actions and capabilities, and what is missing, including the parameter errors `run` would reject. Read-only; no target. It exits 0 even when something is missing, so read `missing`, or pass `--strict` to exit 3 when `missing.parameters`, `recipes`, `actions` or `problems` is non-empty. |
| `search <text…>`                            | Action and recipe ids, descriptions and parameter names, ranked. Every term must match. Shadowed recipes are found by their `<library>.<ref>` id.                                                                                                                                                                                                   |
| `template <name>`                           | A workflow node and a complete recipe skeleton for an action or recipe.                                                                                                                                                                                                                                                                             |
| `completions [bash\|zsh]`                   | A completion script (with `--json`, inside the envelope). `--candidates commands\|actions\|recipes` prints the candidates, ids and aliases included.                                                                                                                                                                                                |

Without `--platform`, the view covers every platform: actions are merged from all scopes, but a recipe is only `runnable` against `shared` declarations, and a recipe that only exists as platform variants reports `runnable: null`. With `--platform`, the view matches what `run --adapter <platform>` resolves.

## JSON output

Every `--json` envelope has `schemaVersion: 1`, `command` and `status` (`ok` or `fail`). Fields may be added; renaming or removing one bumps `schemaVersion`. The TypeScript types are exported from `@farmslot/recipe-cli` (`ListEnvelope`, `ActionsEnvelope`, `DescribeEnvelope`, `ExplainEnvelope`, `SearchEnvelope`, `TemplateEnvelope`, `CompletionsEnvelope`).

| envelope      | main fields                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`        | `platform`, `platforms`, `libraries[]`, `recipes[]` (`ref`, `id`, `source`, `file`, `variant`, `shadows`, `parameters`, `variants`, `runnable`, `problems`)                                  |
| `actions`     | `platform`, `libraries[]`, `actions[]` (`name`, `kind`, `parameters`, `capabilities`, `handler`, `declared`, `source`, `manifest`, `shadows`, `platforms`, `resultCases`)                    |
| `describe`    | `kind` and `recipe` (adds `path`, `resolvedBy`, `proofTargets`, `actions`, `nestedRecipes`, `unresolvedRecipes`, `callers`, `runCommand`) or `action` (adds `schema`, `examples`, `callers`) |
| `explain`     | `recipe` tree (`ref`, `source`, `parameters[]` with `from: input\|default\|missing`, `nodes[]`), `requiredActions[]`, `capabilities`, `missing`, `resolution`                                |
| `search`      | `query`, `results[]` (`kind`, `name`, `id`, `score`, `source`, `description`)                                                                                                                |
| `template`    | `kind`, `name`, `node`, `recipe`, `runCommand`                                                                                                                                               |
| `libraries[]` | `rank`, `name`, `root`, `origin`, `overrides`, `digest`, `platforms`, `adapters`, `actionManifests`, `requires`                                                                              |

Every discovery failure prints `{ "status": "fail", "error": { "code", "message", "userAction" } }` under `--json`, and one `Error [code]` line otherwise. `run` and `validate` keep their own error JSON but use the same exit codes for library problems: `2` for a malformed `--library` or `RECIPE_LIBRARY_PATH` entry (and for unknown options or missing arguments), `1` for an invalid library. Exit code `2` means a usage or lookup problem: `DISCOVERY_USAGE` (including unknown options, missing arguments and a malformed `--library` value), `RECIPE_LIBRARY_PATH_INVALID` (a malformed `RECIPE_LIBRARY_PATH` entry), `DISCOVERY_NOT_FOUND`, `DISCOVERY_NAME_AMBIGUOUS`, `RECIPE_PLATFORM_REQUIRED` or `RECIPE_SHADOWED`. Exit code `1` means an invalid library or an unexpected failure: `RECIPE_LIBRARY_MANIFEST_INVALID`, `RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED`, `RECIPE_LIBRARY_RECIPE_INVALID`, `ACTION_MANIFEST_INVALID`, `RECIPE_SOURCE_INVALID`, other runner resolution errors, or `DISCOVERY_FAILED`.

## Limits

- Discovery sees actions that libraries declare in manifests. An action a product harness registers in code, without a library manifest entry, does not appear until its adapter or library declares it.
- Capabilities come from manifests (`execution_capabilities`) and the protocol's official actions. Product-specific capability rules applied at run time are not reflected.
- `run` still selects platform variants with `--adapter` and needs `--action-manifest`.
