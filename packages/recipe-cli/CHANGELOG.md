# Changelog

All notable changes to `@farmslot/recipe-cli` are tracked here.

## Unreleased

- `RecipeEngine.trustedMutation` hooks receive the adapter the command resolved (`--adapter`, a `--platform` target, or the detected one): `load` gets an `adapter` field, and `authorize` a third argument `{ adapter }`. Both input types are exported from `@farmslot/recipe-cli/harness` as `TrustedMutationLoadInput` and `TrustedMutationAuthorizeContext`, so a host can gate a mutation on the platform without resolving the adapter again.
- Export `resolveTsxBin(tsxCandidates, projectRoot)` from `@farmslot/recipe-cli/harness`, the tsx lookup live adapter scripts run under (`TSX_BIN`, the checkout's tsx, the host package's tsx, the caller's candidates), so a host's readiness check can ask the same question.
- **BREAKING:** `runRecipe` and `preflightRecipe` no longer activate the run environment themselves; call them inside an `activateRecipeRuntimeEnvironment` scope.
- `run` and `call` open one `activateRecipeRuntimeEnvironment` scope around preflight, the platform's `runtimeCheck`, the observers and the execution. All of them see the same ports (the slot's, then `--cdp-port`/`--watcher-port`) and the platform's run environment, and the scope restores the environment on every exit. Network and performance observers keep a copy of that environment taken as they start.

## 0.5.0 - 2026-10-05

- Add `run` and `call` to `@farmslot/recipe-cli/harness`, moved from mm-harness: `handleRun(argv, options)`, `handleCall(argv, options)` and `handleCallHelp(argv, genericHelp, { catalog })`. The host passes a `RecipeEngine` (`RecipeCatalog`: its bundled library, action manifest resolver and validator, and bundled action risk; plus `createRunner`, an optional `trustedMutation` loaded from the command line and bound to the run's plan, the `console` classifier and `runnerIncludes`), and per command `targetDevice`, the `run --plan` host steps and launch wording, and `exampleAction`. `run --list`, `run <recipe> --describe` and `call --list` read the catalog themselves. Messages name the host (`<name> call`, `<product>-checkout`).
  - the engine door: `runRecipe`, `preflightRecipe`, `activateRecipeRuntimeEnvironment` (sets every registered adapter's `devServer.portEnv` from `--watcher-port`), bounded healing and heal-bound envelopes;
  - the recipe library: `resolveLibrarySources`, `listRunnableRecipes`, `describeRunnableRecipe`, `runnableLibraryRecipes`;
  - static validation: `validateRunRecipeStatic`, `validateActionInputs` (each adapter's `actions.inputFindings` on every node), `resolveRecipeParamValue`;
  - `describeManifestActions`, the action catalog entries a host reads for its own action views;
  - network observation through the adapter's `observation.network`: the automatic whole-run capture (off with the host's `AUTO_NETWORK_CAPTURE=0`) and `runNetworkCaptureAction` for `app.network_capture`.
- Add `actions` to `@farmslot/recipe-cli/harness`, moved from mm-harness: `handleActions(parsed, { catalog })` lists, searches (`[query]`), filters (`--category`, `--categories`), describes (`--action`) and dumps (`--raw`) the adapter's actions, and `--matrix` compares them across the registered adapters. `actions`, `run --list`, `call --list` and `run <recipe> --describe` share one discovery module and one catalog renderer.
  - The matrix has one column per registered adapter, in registration order (its JSON `adapters`, the human header and column widths), and a capability no adapter declares reads `across <Adapter>, …, or <Adapter>` from the registry instead of a fixed list.
  - `actions --action <name>` (one match, human output) and `call <action> --help` print the same action detail: the call form, description, source and adapter, risk, result cases, typed fields, up to two example calls, and the first example as a runnable call with its recipe node. The example calls carry only the action's fields (no `next`, `cases` or other graph keys), shell-quoted, under the short name when it is unambiguous. JSON output is unchanged.
- Publish with adapter-sdk 0.4.0, agent-runtime 0.17.0, protocol 0.34.0 and recipe-runner 0.24.0.

## 0.4.1 - 2026-10-05

- Publish with adapter-sdk 0.3.1, agent-runtime 0.17.0, protocol 0.34.0 and recipe-runner 0.24.0 so consumers share one recipe-runner copy.

## 0.4.0 - 2026-10-05

- Add run evidence to `@farmslot/recipe-cli/harness`, moved from mm-harness and driven through the registered adapters and the host identity:
  - execution provenance (`captureExecutionProvenance` with `runnerIncludes`, `executionProvenanceDrift`, `writeExecutionProvenance`, `ProvenanceDriftError`); the runner root defaults to the host package root;
  - the framed recorder (`startRecipeRecording`, `stopRecipeRecording`, `captureActiveRecipeRecordingSnapshot`), `createRecordingTargetProvider` and the capture-helper capability checks;
  - run diagnostics (`beginRunDiagnostics`, `finishRunDiagnostics`, `collectRunDiagnostics`, `verifyConsoleCapture`, `readRunDiagnosticsDocument`, `formatRunDiagnosticsForHuman`), with the console rules injected as a `ConsoleClassifier`;
  - the run report and provenance (`writeRunReport`, `indexProductProvenanceArtifact`, `executedBrowser`, `recipeCdpPorts`);
  - live adapter scripts (`prepareLiveAdapterScript`, `runLiveAdapterScript`, `resolveLiveAdapter`, `liveAdapterProcessTimeoutMs`), with the action `namespace`, input `contextExtras` and extra `tsxCandidates` per call;
  - run options (`recipeRunOptionsFromCli`), recipe trust input and failures (`explicitRecipeTrustOptions`, `recipeTrustFailure`), behavioral proof checks (`validateRuntimeProof`, `validateRuntimeProofPlan`) and `closest`.
- **BREAKING:** the host identity requires `recipeEnvPrefix`, the prefix of the variables recipe processes and library actions read (`recipeEnvName('ADAPTER_INPUT')`); `farmslot-recipe` uses `RECIPE`.
- Add `adapterPortFlags`: the dev-server port options every registered adapter adds.
- Depend on `esbuild` 0.28.1 and `es-module-lexer` 2.3.1, pinned exactly (live adapter bundling): the bundler's patch version changes prepared bytes and so every approved `sourceDigest`.
- Publish with adapter-sdk 0.3.0, agent-runtime 0.17.0, protocol 0.34.0 and recipe-runner 0.23.0.

## 0.3.0 - 2026-10-04

- Add the lifecycle commands to `@farmslot/recipe-cli/harness`, moved from mm-harness and driven through `@farmslot/adapter-sdk` adapters the host registers (`configureHarnessAdapters`): `handleLaunch`, `handleReload`, `handleStop` (with a `companions` hook for host processes), `handleLast`, and `handleHarness` for `install`/`verify`/`cleanup` (with `usage` and `install`-variant hooks). They come with their shared modules: adapter detection and resolution (`detectAdapter`, `adapterForPlatform`, `resolveAdapter`, `assertAdapter`), option parsing (`parseArgs`, `parseFlags`, `CliError`), leaf spawning (`spawnScript`, `spawnScriptStreaming`, `spawnInherit`), teaching errors (`usageOut`, `checkoutBusyOut`, `EXIT`) and bounded healing (`parseHeal`, `ensureOverlay`, `classifyFailure`, `checkHealBounds`). Platform policy comes from the adapters (`detect`, `targets`, `flags`, `failurePatterns`), and names from the host (new `product` field, required).
- Add `@farmslot/recipe-cli/harness`, the generic support a harness CLI runs its commands on: the host identity (`configureHarnessHost`: name, env prefix, package, executable, journaled commands), runtime paths (`recipeRuntimeDir`, `recipeRuntimePath`, `recipeHarnessRoot`, `recipeHarnessPath`, `harnessExecutable`), the resumability journal (`withCommandJournal`, `readCommandJournal`, argument redaction), the checkout lock (`acquireCheckoutLock`, `trackCheckoutChild`), `JsonStreamWriter`, colour helpers, contained artifact writes, Git library provenance and shell-leaf invocation. Moved from mm-harness; a product preset keeps its own env names (`MM_HARNESS_*`) through the host identity.
- Publish with protocol 0.34.0, recipe-runner 0.23.0, agent-runtime 0.17.0 and adapter-sdk 0.2.0 (agent-runtime and adapter-sdk are new dependencies of the harness support).

## 0.2.0 - 2026-10-04

- Depend on `@farmslot/recipe-runner` (renamed from `@farmslot/recipe-harness`).
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.

## 0.1.2 - 2026-10-04

- Export the action catalog helpers a host CLI needs on top of its own action manifest: `actionCategory`, `fuzzyResolveActions`, `shortActionNames`, `searchActions`, `findRelatedActions`, `summarizeActionCategories`, `actionCapabilityMatrix`, `resolveActionCapabilityRefusal` and `missingActionCapabilities`. `search` ranks with the same scorer, so its results are unchanged.

## 0.1.1 - 2026-10-03

- Publish with recipe-harness 0.22.1 so `require('@farmslot/recipe-cli')` works from CommonJS.

## 0.1.0 - 2026-10-02

- Add the `farmslot-recipe` front door, moved from `@farmslot/recipe-harness`: `run` and `validate` as before, plus library-wide discovery with stable `--json` envelopes. `actions`, `list`, `describe`, `explain`, `search`, `template` and `completions` resolve every library on `RECIPE_LIBRARY_PATH` and `--library`, show precedence, shadows, namespaced `<library>.<ref>` ids and library digests, and work for a library with no platform adapter. Discovery and `run` resolve refs, platform aliases and ids identically; every failure prints the `--json` error envelope, and usage errors (malformed `--library` included) exit 2. `search` finds shadowed recipes by id, `explain --strict` exits 3 on gaps, and each command loads a library set once per platform.
- `assessRecipe` accepts any `RecipeReadinessView` (`{ resolution, manifest }`), so a host can judge readiness on its own single-platform resolution against the manifest its runner executes. `buildDiscoveryIndex` vouches only for the `packageVersions` the host passes, so a library's `requires` gives discovery and the host's `run` the same answer; `farmslot-recipe` still vouches for itself.
- Export `assessRecipe` so host CLIs can judge any resolved recipe, a qualified alias included, with the same readiness rule as `list`.
- `search` without `--platform` finds shadowed platform-only recipes by their `<library>.<ref>` id, listing each id once.
- Publish with protocol 0.34.0 and recipe-harness 0.22.0 so consumers share one protocol and runtime.
