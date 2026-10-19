# @farmslot/recipe-cli

Recipe discovery and the harness SDK behind `farmslot recipe`. Discovery tells you what your recipe
libraries offer before you run anything; it needs only a library on disk: no app, device or
platform adapter.

```sh
export RECIPE_LIBRARY_PATH="hello=./recipe-library"
farmslot recipe run --list --project-root .
farmslot recipe actions --project-root .
farmslot recipe run hello.greet --describe --project-root .
farmslot recipe run greet-twice guest=Ada --plan --project-root .
```

The package ships no executable. `runRecipeCli` and `registerDiscoveryCommands` give a host the same
`run`, `validate` and discovery commands, and `@farmslot/recipe-cli/harness` the generic harness.

Docs: https://farmslot.io/docs/reference/recipe-discovery

## Source layout

| path                                                | owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                                        | `runRecipeCli`: the runner's `run`/`validate` plus discovery, for a host to embed                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/commands.ts`                                   | discovery command registration, JSON envelopes and errors                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/libraries.ts`                                  | library resolution: precedence, overrides, digests, `requires` checks                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/discovery-index.ts`                            | the recipe and action index for one platform view                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/composition.ts`                                | composition, callers and `explain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/search.ts`, `src/template.ts`, `src/render.ts` | search ranking, skeletons, text output                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/types.ts`                                      | the documented `--json` schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/harness/`                                      | generic harness support (`@farmslot/recipe-cli/harness`): host identity, adapter registry and library adapter plugins, runtime paths, journal, checkout lock, JSON stream, colour, option parsing, leaf spawning, bounded healing, run evidence (execution provenance, framed recording, run diagnostics, run report, live adapter scripts, run options, trust input, behavioral proof), and the run engine (`RecipeEngine`, recipe library, static validation, action catalog, network observation) |
| `src/harness/commands/`                             | commands a host CLI dispatches to: `run`, `call`, the lifecycle (`launch`, `reload`, `stop`, `last`), and discovery (`discover.ts`: `actions`, `run --list`, `run --describe`, `call --list`); `overlay.ts` is `install`/`verify`/`cleanup`                                                                                                                                                                                                                                                          |

## Maintenance rules

- Discovery is generic. Product names, platforms and actions come from libraries, never from this package.
- Library loading, recipe identity and precedence belong to `@farmslot/recipe-runner`; this package reads them and must not re-implement them.
- `--json` envelopes are a contract: add fields freely, but bump `DISCOVERY_SCHEMA_VERSION` before removing or renaming one.
- Discovery never runs actions or loads adapter code.
- Harness commands never compare adapter ids: platform behaviour comes from the registered `@farmslot/adapter-sdk` adapters, and a new behaviour is a new adapter member.
- `src/harness/` never hardcodes a product: names and env variables come from the host identity (`configureHarnessHost`: `envPrefix` for the host's own variables, `recipeEnvPrefix` for the ones recipe processes and library actions read), so a preset such as `mm-harness` keeps its own spelling. Runtime paths are shared by every host (`temp/recipe/runtime`, `temp/recipe/harness`; `RECIPE_RUNTIME_DIR` and `RECIPE_HARNESS_ROOT` override them).

## Local quality

```sh
yarn workspace @farmslot/recipe-cli quality
```
