# Project recipe contract

**Status:** Accepted normative specification, approved with [ADR-066](../adr/066-project-recipe-binding-and-conformance.md).
**Owner:** Farmslot maintainers

MUST, MUST NOT and SHOULD describe the intended contract. This specification extends [Recipe Protocol v1](recipe-protocol-v1.md), the [runtime capability contract](recipe-runtime-capability-contract.md) and the existing project/template/resource contracts. It does not claim that all migration gates are already implemented or validated.

## 1. Ownership

| Contract                      | Owner                                               | Project responsibility                                                                                                                     |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pack/project/pool declaration | CLI onboarding, protocol and slot-config            | Declare provider, app/domain and ordered library references; supply machine values through pool/slot configuration                         |
| Executable provider           | adapter-sdk runtime and recipe-cli host             | Implement project runtime/action behavior and domain authorization; return an engine only when the default needs a domain policy extension |
| Recipe library                | recipe-runner library loader and protocol manifests | Declare strict actions and reusable graphs with source ownership and versions                                                              |

There MUST be one resolved binding shared by direct and hosted commands. There MUST be one revision-bound report representation for static and live results. Resource leases MUST remain gateway-owned. No report, badge or CLI flag grants a lease, funding approval or permission to import discovered code.

## 2. Binding and defaults

Resolution order MUST be explicit flags, checkout runtime binding, pool slot, unique detection, then configured default. Resolution begins at the checkout Git root and then selects the declared app. Ambiguous project, app, runtime or target selection MUST refuse with candidates or a concrete repair instruction.

The binding MUST include project, app/domain, runtime and requested platform, target checkout, selected pool slot when any, device/ports, provider and library references, and runtime/artifact directories. Explicit device or port inputs MUST NOT silently select a different leased target. Device mutation MUST never broadcast to all discovered targets.

Executable providers and library plugins MUST be configured or explicitly authorized before import. Metadata discovery alone MUST NOT authorize executable code. A declared repository library MUST name its owner and exact revision. Bundled libraries inherit their provider's identity. Local overrides MUST be explicit and visible in provenance.

Every run and check MUST use the same resolved provider and recipe bytes throughout the operation. Source/configuration drift detected during checking MUST fail the result. Generated runtime and artifact outputs may be excluded only through the existing guarded output-root rules; source files cannot be exempted merely to keep a report current.

## 3. Provider composition and lifecycle

`createProvider(context)` returns a runtime and MAY return an engine, `cancel`, `finalize`, and shared doctor/status/stop/logs command options. The host MUST validate provider-specific invocation grammar before calling the factory. A partially failing factory owns its own rollback; once a provider is returned, the host MUST await its finalization on success, refusal and failure.

The default engine MUST use existing graph, action, library, trust and artifact contracts. Projects MUST NOT implement a second graph executor, CLI parser, resource allocator or artifact validator.

Project hooks may contribute:

- Readiness checks, device views, checkout/feature-flag presentation and optional recorder readiness.
- Explicit repair callbacks and their next actions, only under `doctor --fix`.
- Runtime launch/reload/stop/log sources and owned companion cleanup.
- Domain action implementations, plugin policy and plan-bound funding authorization.

Ordinary doctor, discovery and plan modes MUST NOT repair fixtures, launch apps, claim mainnet ownership or execute actions. Report writes are ordinary output artifacts. `--fix`, lifecycle mutation, action calls and recipe execution are explicit operations. Source-build and verified-artifact launch modes remain project-owned capabilities and must retain their existing arguments and checks.

SIGINT, SIGTERM and SIGHUP MUST reach owned execution children. Cancellation MUST run authored teardown with a usable cleanup signal and then finalize provider-owned resources. Cleanup MUST NOT kill foreign processes or alter another run's slot. Closeout errors MUST remain visible; an unconfirmed remote closeout MUST preserve the existing gateway hold and MUST NOT be retried as a fresh execution.

Status MUST retain readiness, latest command and latest execution evidence pointers. A later plan or stop MUST NOT hide the latest recipe evidence. Failure evidence remains evidence of failure, never a success badge.

### Log view composition

`ProjectProvider.commandOptions.logs` MAY supply `LogsCommandOptions` from `@farmslot/recipe-cli/harness`. Its consumers are the shared `handleLogs` and MetaMask provider composition. The public types are:

```ts
interface LogsViewRequest {
  target: string;
  logFile: string;
  events: string;
  mode: string;
  signal?: AbortSignal;
}
interface LogsWindowRequest {
  target: string;
  logFile: string;
  signal?: AbortSignal;
}
interface LogsWindowResult {
  window: string;
  logFile: string;
  exitCode: number;
}
interface LogsCommandOptions {
  compact?(request: LogsViewRequest): Promise<number>;
  window?(request: LogsWindowRequest): Promise<LogsWindowResult>;
}
```

The shared handler MUST resolve and validate the source before calling either hook. It MUST prefer the named application source, retain the `app` selector, and refuse missing application output rather than substituting build logs. Hooks receive the resolved target and log path, not unvalidated CLI input. They MUST use the host signal and existing owned-child closeout.

| Invocation                      | Required behavior and consumer                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recipe logs --json`            | Operators and diagnostics get source metadata, with no follower or viewer window                                                                                                                                                                                         |
| `recipe logs` / `--events N`    | With a compact hook, human operators follow project events; explicit count overrides `RECIPE_LOG_EVENTS`, then20; explicit values retain legacy digit-only validation. Without that hook, the existing bounded raw default remains and `--events` refuses as unsupported |
| `recipe logs --full`            | Human operators get unfiltered output from the first line and follow; existing raw `--lines N [--follow]` remains available                                                                                                                                              |
| `recipe logs --window [--json]` | Operators reopen the primary dev-server log window; JSON reports the window operation rather than starting a foreground follower                                                                                                                                         |

Ordinary JSON inspection MUST NOT call compact/window hooks. `--window --json` is an explicit window operation, as in the existing CLI. Window mode uses the first declared dev-server source, regardless of the selected application source, after the existing source-availability checks. It MUST refuse when that source or the window hook is absent. The provider MAY resolve its existing window name and ports, but MUST select only the explicitly handed-off or prepared run session. It MUST NOT create/kill a tmux server or session, choose an ambient session, or focus a window. It may replace only its own named log window, preserving the existing recovery contract and exposing command failures.

For compact display, the host forwards `RECIPE_LOG_UI_MODE` or `compact` to the provider hook. MetaMask's existing event classification, formatting, count normalization and mode behavior MUST be preserved through the reused helper; this migration does not reinterpret zero or environment values. A runtime without a compact hook MUST retain the existing bounded20-line default and opt-in `--follow`; it MUST refuse explicit `--events` as unsupported. Explicit `--lines` or `--follow` selects the existing raw-line path; `--events` with explicit raw-line selectors MUST refuse conflicting selection. `--full` keeps its existing raw precedence. The canonical `recipe-project.ts` grammar MUST register `--events <count>` and `--window`. It MUST distinguish an operator-supplied `--lines` from an omitted option: remove the Commander default and retain20 in the handler, so invocation serialization cannot turn omission into an explicit raw selector. Regenerate the reference from that grammar. An absent window hook is an explicit unsupported operation, never a success.

MetaMask MUST extract the compact/window calls once from its old handler into provider helpers, using the existing asynchronous streaming primitive. Both entrypoints may consume those helpers during Phase 2. A helper MUST NOT execute `mm-harness logs` or delegate to the legacy handler. Provider grammar still runs before factory effects. Status/doctor/conformance do not open viewers.

The remaining provider log viewer also serves Mobile/Extension launch and injected Extension scripts. Phase 3 MUST inventory and migrate those callers before extracting shared viewer/session mechanics or deleting old paths. Completion requires one generic implementation, MetaMask classification/policy only in the provider, and no legacy CLI alias or forwarding shim.

Acceptance requires legacy/shared compact output and count/environment parity, no JSON follower, observed appends, failed-source refusal, full raw output, and PID-only INT/TERM/HUP with complete child closeout. Public-CLI cases MUST prove that omission calls the compact hook, explicit `--lines`/`--follow` select raw output, `--events` is not rejected because of a synthesized default, and raw/event conflicts refuse. No-hook cases MUST prove a bounded20-line default that exits, opt-in follow, and explicit unsupported-event refusal. Window command tests MUST use a fake tmux executable and prove exact run targeting, no server/session creation or destruction, no focus changes, and missing-session refusal. Actual existing-session window proof remains a separately coordinated live gate under COMMON.md; fake commands do not prove that live behavior.

## 4. Static and live conformance

Static conformance MUST validate declared recipe dependencies, effective parameters, manifest schemas/examples, handler availability and complete runner preflight, including authorization. It MUST NOT execute the recipe. A declaration without an implementation MUST fail when required by the checked invocation.

### Default static invocations

The optional `project.json` member `recipe.checks` declares the default static conformance invocations for that resolved project/app/runtime binding. It is metadata in the existing project declaration, not another provider or capability contract. Each entry MUST contain a nonempty `recipe` ref from the binding's composed libraries and MAY contain `params`, a JSON object. Defaults use the existing library resolver; they MUST NOT contain absolute or checkout-relative file paths. Explicit `--recipe` file behavior is unchanged. The array, when present, MUST be nonempty. Unknown entry members and duplicate refs after the existing ref normalization MUST be rejected. Different input sets for the same ref SHOULD use an authored wrapper recipe with existing `call` inputs.

For example, a configured provider with a bundled `smoke` recipe can declare:

```json
{
  "recipe": {
    "provider": { "module": "./provider.mjs" },
    "adapter": "headless",
    "checks": [{ "recipe": "smoke" }]
  }
}
```

Selection MUST follow these rules:

1. Explicit `--recipe` values replace the default list. Existing `--param` processing and its requirement for explicit `--recipe` remain unchanged; parameters MUST NOT silently merge into defaults.
2. Without explicit recipe selection, static conformance MUST use every declared default invocation with its declared `params`, or an empty parameter object when omitted. After JSON/type validation, these inputs use the existing recipe parameter/default validation and full dependency, handler and authorization preflight. No second semantic parameter parser is introduced.
3. With neither explicit refs nor declared defaults, the command MUST refuse and name both repairs: declare `recipe.checks` in the selected project, or pass `--recipe`. It MUST NOT select the first catalog recipe, enumerate the catalog as required invocations, guess missing inputs, or downgrade failed invocations to skipped/optional passes.
4. Invalid metadata MUST fail before executable provider import, including an empty array, malformed entry or duplicate ref. A well-formed default invocation that fails runtime preflight does not block checking a different explicit invocation; explicit selection still validates the project declaration itself.
5. Defaults MUST NOT grant mutation/funding consent, reset fixtures or acquire resources. Values needed for authorization remain governed by the existing engine/provider policy. Secrets belong in the existing provider/runtime configuration, not project metadata.

Default selection MUST NOT suppress the existing pack/library/schema/example, SDK/version or manifest-to-handler checks. It changes which concrete invocations receive complete preflight, not the validity requirements of the declared project and catalogs.

The report MUST bind the selected invocations, effective parameter identities and the complete project configuration. It certifies those checks, not every callable recipe. Changing default refs/params or configuration invalidates reuse through the existing identity checks. The report's result/identity meaning and serialization do not change; this amendment changes default selection only.

The public CLI and hosted execution continue to use the same binding and preflight. Gateway dispatch MUST still pass the chosen flow's explicit `recipe_checks`/`recipe_params`; project defaults MUST NOT add obligations to that flow or to Static Review. Live conformance still requires its existing explicit `--recipe`, disposable-target consent, named smoke/teardown assertions and allocation checks; defaults cannot activate a live run.

Before claiming the no-selection-flags acceptance gate, every prepared farm/sample in the rollout MUST declare its intended default checks, and the public command MUST pass with no target/project/library/recipe selection flags on that binding. An omitted declaration remains an explicit configuration refusal. Library applicability and other catalog invocations remain inspectable through normal discovery and explicit preflight; this selection policy does not conceal their failures when requested.

### Report identity and live evidence

A report identity MUST bind:

- Project, app, domain, runtime, requested target family, checkout and selected pool/device/port inputs.
- Checkout HEAD, dirty digest when applicable and a content fingerprint.
- Provider, library, configuration and shared implementation fingerprints.
- Selected recipe invocations and parameter digests.
- The execution trust inputs used by preflight, without exposing secret values.

Report schema version 1 contains `checkedAt`, `identity`, `status`, `mode`, `checks`, scoped `capabilities`, and resolution/provenance where available. A required check passes only with positive evidence. Missing, skipped and unsupported checks are distinct from a passing check. Static evidence includes the complete execution plan.

Live conformance MUST run one declared bounded smoke per requested target through the same public provider loader. It requires explicit disposable-target consent, a named runtime proof target and a named assertion in authored teardown. The default deadline is 120 seconds; the accepted override is positive and at most 300 seconds.

A standalone live target MUST be a disposable headless checkout. A pooled live target MUST name its existing owning run; the host MUST verify the gateway allocation and required resource health and observe ownership loss/disconnection. It MUST abort rather than acquire a lease or displace another run.

A live pass MUST retain and validate authored recipe/dependency resolution, trace, summary and artifact manifest, including runner provenance. The live evidence record names the smoke/teardown targets and hashes the retained files.

The report MUST record capture and HUD support for its checked target using the existing check entries `capture.support` and `hud.support`. These descriptive entries have `required: false`, with status `pass` and message `supported`, or status `unsupported` and message `headless` or `opaque`. They do not establish runtime proof. A broken advertised transport MUST fail validation, not become unsupported.

Recipe execution MUST default the HUD on only where the target supports it. On a HUD-capable target, live conformance MUST retain a screenshot or recording of the proof step with the step-intent HUD visible. The capture MUST belong to that execution and proof step, appear in the artifact manifest and be bound by the live report's artifact hashes. Live validation MUST check the retained capture for the visible HUD; a registered handler, successful HUD command or trace marker alone MUST NOT satisfy this requirement. Reuse the existing runtime/capture evidence contracts and visual acceptance checks. Missing capture or absent HUD MUST prevent a live pass and `recipeVerified`. Headless or opaque targets record unsupported with the reason and MUST NOT be assigned fabricated UI proof. Selected capture requirements still apply independently.

`--check-report` MUST recompute current identity/preflight and validate retained artifact bytes. Changed parameters, code, target, configuration or evidence MUST reject reuse. It MUST neither rerun the smoke nor overwrite the saved report. The report timestamp is provenance, not a grant of ongoing runtime readiness.

## 5. Selected-flow requirements and compatibility

The gateway MUST use the existing template selector and QA preset resolver. It MUST NOT infer requirements from a project name, numeric compatibility level or unrelated flow. Static Review keeps its existing template admission and MUST NOT acquire runtime QA requirements automatically.

Optional flat template metadata is:

| Field                  | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `recipe_checks`        | Recipe refs whose complete preflight is required                                                          |
| `recipe_actions`       | Action handlers that must occur in the successfully preflighted smoke plans                               |
| `recipe_capture`       | Require capture action support in those plans                                                             |
| `recipe_hud`           | Require HUD action support in those plans                                                                 |
| `runtime_capabilities` | Existing resource-provider IDs required by the selected flow                                              |
| `recipe_params`        | Proposed JSON object carried as a scalar in frontmatter and passed through the existing `--param` grammar |

Lists MUST contain nonempty names; capture/HUD fields MUST be booleans. Action/capture/HUD requirements MUST have an authored smoke in `recipe_checks`. They establish available handler support, not proof that a screenshot or HUD was produced at runtime.

`recipe_params` MUST decode as one JSON object. Each value MUST reach the CLI without type or quoting changes, including strings, arrays and nested objects. The gateway serializes values as JSON assignments and the canonical recipe parameter parser validates them; a second semantic parser MUST NOT be introduced. The same object applies to all selected refs, matching repeated CLI `--recipe` semantics. Different parameter sets SHOULD be composed through existing recipe `call` inputs in one authored smoke. Opaque QA skill inputs MUST NOT be guessed into recipe parameters.

For example, the existing flat frontmatter parser can carry:

```yaml
recipe_checks: [smoke]
recipe_actions: [example.read]
recipe_params: '{"expected":"hello, world","attempts":2,"items":["one","two"]}'
```

Preview MUST report missing requirements. Dispatch MUST recheck after prepare and before worker launch using the selected template's retained identity. Runtime resource support MUST come from the existing catalog; these checks MUST NOT acquire or release resources. A static check uses a separate contained report filename so it cannot replace retained live proof.

The shared compatibility model MUST expose:

- `registered`: a valid configured provider declaration exists.
- `recipeVerified`: current positive live evidence exists for the selected project/app/domain/runtime/target and required smoke checks.
- Each selected requirement as `declared`, `verified`, `failed` or `unknown`, with missing requirements and diagnostics.
- The checked revision, dirty digest, time and target scope.

Manifest presence alone MUST NOT establish handler coverage. Resource availability and preflighted capture/HUD support are declarations, not acquired-resource or visual-proof verdicts. A stale live report may lead to fresh static preflight, but the result MUST remain unverified for live execution and retain the refusal diagnostic.

Pure requirement validation and compatibility derivation belong in `@farmslot/protocol`. Gateway admission, Command Center and future Companion views MUST consume that model or its unchanged wire result. Renderers MUST clear retained results when their target/flow/profile or gateway identity changes and ignore late responses for prior selections. Existing resource lease controls remain the resource controller; no second lease panel or client-side admission implementation is introduced.

## 6. Library references and cutover

The final composed-library interface MUST resolve `<library>/<ref>` to the named library. A bare ref MUST resolve only when unique across the composed set; ambiguity MUST list candidates. Exact qualified-ref overrides follow declared source precedence and MUST retain winners and shadows in describe/conformance/provenance. Cross-library dependency closure, version requirements and trust MUST be checked before effects.

The final SDK names are `ProjectRuntime`, `ActionCatalog`, `ActionHandler` and `RecipeEngine`. The first three replace `PlatformAdapter`, `AdapterActions` and `ActionAdapter` in one coordinated cutover of exports, imports and documentation. Type renames MUST NOT independently rename protocol action IDs or unrelated wire fields. Compatibility aliases and deprecation shims MUST NOT remain.

Before deleting old binaries or command glue, every moved/removed command, flag, export, doctor check, environment variable and script MUST have an old-to-new mapping with parameter translation and a tested consumer, or an unused-reference proof. Project authorization, plugin fencing, device targeting, source/artifact checks, closeout and signal teardown MUST have provider/engine homes first.

The final `farmslot-recipe` binary and superseded user-facing harness/project-hook routes MUST be removed after that audit and live equivalence proof. Remaining gateway consumers MUST reach the canonical host. Obsolete recipe-harness code may be deleted only after the same caller audit.

## Public surface

### CLI

The canonical command grammar MUST generate help, completions and the CLI reference shipped with Phase 2. Provider-owned grammar remains the source for project-specific options.

| Command/flags                                                                                           | Named consumer and guarantee                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `recipe status`                                                                                         | Operators and task tooling; readiness, journal and evidence pointers                                                                           |
| `recipe launch [--verify]`, `reload`, `stop`, `logs`                                                    | Pack/workflow lifecycle callers; selected target and owned cleanup                                                                             |
| `recipe actions [query] [--action name]`                                                                | Operators and recipe authors; declared discovery and exact detail                                                                              |
| `recipe call <action> [key=value]`                                                                      | Single-action callers; same authorization and finalization as graphs                                                                           |
| `recipe run <ref\|file> [key=value] [--list\|--describe\|--plan]`                                       | Operators, libraries and hosted execution; complete resolution/preflight before effects                                                        |
| `recipe artifacts [dir\|task] [--validate] [--format markdown]`                                         | Evidence/review consumers; existing artifact validation and rendering                                                                          |
| `doctor [checkout]`, `--target`, `--expect-live`, `--print-ready`, `--all-devices`, `--action-manifest` | Operators and project health hooks; shared readiness with project options                                                                      |
| `doctor --fix [--json-stream]`                                                                          | Explicit operator repair; bounded owned children and one terminal result after finalization                                                    |
| `doctor --conformance [--recipe ref] [--param key=value]`                                               | Authors check declared defaults or explicit invocations through full preflight; gateway admission supplies explicit selected-flow requirements |
| `--live --disposable --smoke-target id --teardown-target id [--run id] [--live-timeout-ms ms]`          | Live conformance; explicit target ownership, observed effect and cleanup                                                                       |
| `--check-report path`                                                                                   | Gateway/author report reuse; current identities and artifact bytes required                                                                    |
| `--report-name name.json`                                                                               | Gateway dispatch preflight; separate artifact without overwriting live proof                                                                   |
| `--artifacts-dir`, source trust/kind and `--approve-plan`                                               | Existing output/authorization consumers; retain engine and project policy, never infer approval                                                |
| Project/registry/app/domain/library/provider/slot/device/port selection options                         | Direct CLI, pack and hosted callers; use the one binding and existing authorization rules                                                      |

The referenced grammar inventories exact selection/provider flags. This specification changes no authority by merely grouping them. Conformance-only switches MUST require `--conformance`; readiness repair/probe switches MUST NOT be mixed with it. `--report-name` MUST be a contained JSON filename and MUST NOT be combined with `--check-report`.

### SDK exports and extension points

| Owning package                 | Public surface                                                                                                                                         | Named consumer                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `@farmslot/adapter-sdk`        | Runtime/ActionCatalog contracts; optional `AdapterReadiness.recorder` until the coordinated naming cutover                                             | MetaMask recorder readiness and other project runtime providers                                     |
| `@farmslot/recipe-cli/harness` | Existing `resolveProjectContext`, `loadProjectProvider`, `withProjectRecipeHost`, `ProjectProvider`; optional doctor/status/stop/logs `commandOptions` | Public CLI and executable project providers                                                         |
| `@farmslot/recipe-cli/harness` | Shared `handleDoctor`, `handleLaunch`, `LaunchCommandOptions`, `handleLogs`, status/reload/stop handlers                                               | Public lifecycle CLI; harnesses inherit mechanics and supply runtime hooks                          |
| `@farmslot/recipe-cli/harness` | `LogsCommandOptions`, `LogsViewRequest`, `LogsWindowRequest`, `LogsWindowResult`                                                                       | Shared logs handler and MetaMask compact/window provider helpers; same pre-1.0 release policy below |
| `@farmslot/recipe-cli/harness` | `DoctorFixResult`, asynchronous doctor repair contract, `doctorReady`, `renderDoctorRecorder`                                                          | Shared readiness and MetaMask doctor composition                                                    |
| `@farmslot/recipe-cli/harness` | `HarnessHost.doctorCommand`, host journal configuration, `readLatestProofJournal`                                                                      | Public recovery hints, status and artifact defaults                                                 |
| `@farmslot/recipe-cli/harness` | Existing conformance identity/check/write/reuse APIs and extended runtime-proof validation                                                             | Root doctor and retained evidence verification                                                      |
| `@farmslot/recipe-cli/harness` | Existing contained-path helper exposed as `isPathWithin`                                                                                               | Root doctor's retained artifact containment check                                                   |
| `@farmslot/recipe-runner`      | Existing graph/library/trust APIs and `digestFileWithinRoot`                                                                                           | Default engine and artifact-byte binding                                                            |
| `@farmslot/protocol`           | `ProjectRecipeConfig.checks` and its existing declaration validator/schema                                                                             | Project packs declare default static invocations; the resolved binding and root doctor consume them |
| `@farmslot/protocol`           | `RecipeConformanceLiveEvidence`, report/check/scope types, `RecipeFlowRequirements`, `RecipeProjectCompatibility`, `conformanceChecksPass`             | CLI, gateway and compatibility consumers                                                            |
| `@farmslot/protocol`           | Proposed shared `recipeFlowRequirements` and `recipeProjectCompatibility` validation/projection                                                        | Gateway selected-flow admission; thin clients consume the resulting model                           |

Gateway preview carries optional `recipeCompatibility`. The existing hosted hook result may carry a validated conformance report during migration. Internal conformance options MUST NOT be supplied by untrusted wire fields or bypass project/slot matching, pool environment, cancellation and closeout tracking.

MetaMask retains its own funding, fixture, plugin, device and collector policy. Its provider consumes shared command options and optional recorder readiness; its engine consumes the same scoped trust/cancellation path. Other harnesses can omit unsupported hooks and inherit the default engine. They MUST NOT copy generic orchestration to fill an absent capability.

### Stability and versioning

Existing published APIs retain their accepted behavior until the coordinated cutover. Proposed additions are experimental until reviewed release commits, CI and package checks pass. New pre-1.0 SDK features and breaking type renames receive minor releases; unchanged dependants receive required coordinated pin updates. Shared manifests, lockfiles and release versions require a reviewed release proposal before editing/publication. Registry-only consumer checks MUST prove dependency closure; a local source override cannot substitute for published dependencies.

A schema-v1 report may add optional data without changing existing meaning. Incompatible semantics require an explicit schema transition. The generated reference MUST change with the canonical grammar. No flag or SDK export may ship without the consumer named here or in an approved revision of this specification.

## 7. Acceptance gates

| Gate                 | Required evidence                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding/preflight    | Headless project success; ambiguous target/provider refusal; missing handler failure; changed identity or parameter refusal                                                                                                                          |
| Default conformance  | Declared checks pass without selection flags on every prepared farm/sample; explicit selection overrides; absent/invalid defaults, missing parameters/handlers and changed report identities refuse; no import/effect during invalid metadata checks |
| Direct/hosted parity | Same provider/recipe identities on the same target; mismatch refusal; retained evidence and confirmed signal closeout                                                                                                                                |
| Lifecycle/readiness  | Old/new field and behavior mapping, runtime launch/verify where supported, owned stop/collector cleanup, read-only status/doctor, explicit repairs                                                                                                   |
| Live conformance     | Actual effect, positive assertion, authored cleanup assertion, complete validated artifact bytes, no lease takeover; captured proof-step intent HUD verified on supported targets, explicit support/reason recorded otherwise                        |
| Selected flow        | Static review independent of runtime QA; required recipe/action/resource/parameter failures; no cross-target or cross-domain verification                                                                                                            |
| UI                   | Actual browser interaction/rendering plus real gateway-backed dispatch evidence; late results cannot certify another selection                                                                                                                       |
| Tutorial/docs        | A fresh reader follows only the tutorial through passing live conformance and one real dispatched run reaching its gate; every point of confusion becomes a doc fix                                                                                  |
| Cutover              | Complete old-to-new/unused map, live differential outcomes and artifact shape, callers migrated, obsolete binaries/routes/aliases removed                                                                                                            |
| Release              | Exact-head independent approvals, green required CI, package/import/archive/registry checks, coordinated publication and installed validation                                                                                                        |

The target matrix covers MetaMask Core, Mobile on iOS simulator and physical Android, Extension, and Terminal with its signer. Each phase needs one real dispatch per farm reaching its gate. Audiolab and EchoBridge follow with their declared web/iOS/Android targets after their migrations and the MetaMask sequencing. A verified row does not establish another row. Record baseline failures and unresolved targets without inflating evidence.

Unit/fixture tests support regression diagnosis but cannot replace those live rows. Default tests must stay under five seconds each and suites under five minutes; longer runtime proof belongs in the manual live tier. Tests MUST NOT start or kill a real tmux server. No shared build output may be rewritten under readers.
