# @farmslot/recipe-cli

The `farmslot-recipe` command: run and validate Recipe Protocol v1 recipes, and discover what
your recipe libraries offer. Discovery needs only a library on disk: no app, device or platform
adapter.

```sh
npm i -D @farmslot/recipe-cli
export RECIPE_LIBRARY_PATH="hello=./recipe-library"
npx farmslot-recipe list
npx farmslot-recipe actions
npx farmslot-recipe describe hello.greet
npx farmslot-recipe explain greet-twice --param guest=Ada
```

| command                   | answers                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `actions`                 | every action the libraries declare or this CLI handles, with its parameters |
| `list`                    | recipes across all libraries, with variants and whether they can run        |
| `describe <name>`         | parameters, examples, outputs, callers and variants of a recipe or action   |
| `explain <recipe>`        | the resolved call graph, parameter flow, required actions and gaps          |
| `search <text>`           | ids, descriptions and parameter names                                       |
| `template <name>`         | a ready-to-edit workflow node and recipe skeleton                           |
| `completions [bash\|zsh]` | a shell completion script                                                   |

Every command takes `--library name=path` (repeatable), `--platform <id>` and `--json`.

Docs: https://farmslot.io/docs/reference/recipe-discovery

## Source layout

| path                                                | owns                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                                        | the `farmslot-recipe` program: the runner's `run`/`validate` plus discovery                                                         |
| `src/commands.ts`                                   | discovery command registration, JSON envelopes and errors                                                                           |
| `src/libraries.ts`                                  | library resolution: precedence, overrides, digests, `requires` checks                                                               |
| `src/discovery-index.ts`                            | the recipe and action index for one platform view                                                                                   |
| `src/composition.ts`                                | composition, callers and `explain`                                                                                                  |
| `src/search.ts`, `src/template.ts`, `src/render.ts` | search ranking, skeletons, text output                                                                                              |
| `src/types.ts`                                      | the documented `--json` schema                                                                                                      |
| `src/harness/`                                      | generic harness support (`@farmslot/recipe-cli/harness`): host identity, runtime paths, journal, checkout lock, JSON stream, colour |

## Maintenance rules

- Discovery is generic. Product names, platforms and actions come from libraries, never from this package.
- Library loading, recipe identity and precedence belong to `@farmslot/recipe-runner`; this package reads them and must not re-implement them.
- `--json` envelopes are a contract: add fields freely, but bump `DISCOVERY_SCHEMA_VERSION` before removing or renaming one.
- Discovery never runs actions or loads adapter code.
- `src/harness/` never hardcodes a product: names and env variables come from the host identity (`configureHarnessHost`), so a preset such as `mm-harness` keeps its own spelling. Runtime paths are shared by every host (`temp/recipe/runtime`, `temp/recipe/harness`; `RECIPE_RUNTIME_DIR` and `RECIPE_HARNESS_ROOT` override them).

## Local quality

```sh
yarn workspace @farmslot/recipe-cli quality
```
