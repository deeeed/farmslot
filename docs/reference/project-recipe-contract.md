# Project recipe contract

**Status:** Accepted normative specification, approved with [ADR-068](../adr/068-project-recipe-binding-and-conformance.md).
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

### Bridge installation (proposed Amendment 2)

**Status:** Proposed by [ADR-068 Amendment 2](../adr/068-project-recipe-binding-and-conformance.md#amendment-2-built-in-bridges-2026-10-14). This section is not a shipped capability until the amendment, implementation and coordinated release are accepted.

The existing `ProjectRuntime.harness` / `AdapterHarness` declaration in `@farmslot/adapter-sdk` MUST distinguish these forms:

| Declaration                                                 | Required members                                           | Meaning                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `kind: 'overlay'`, or the existing declaration with no kind | Existing `install`, `cleanup`, `verify` members            | The bridge uses the existing checkout overlay lifecycle.              |
| `kind: 'built-in'`                                          | Existing `verify` member; no `install` or `cleanup` member | The bridge ships in the application and requires no checkout overlay. |

Both forms retain existing verification arguments and restart behavior where declared. The SDK MUST validate through the existing `defineAdapter` / registry registration checks, including providers that return plain objects. Unknown kinds, a built-in declaration with installer/cleanup leaves, and incomplete overlay declarations MUST refuse before overlay effects. Missing members MUST NOT imply built-in mode. Headless runtimes retain their existing overlay exemption; built-in mode MUST NOT turn a UI runtime into a headless one.

For a built-in bridge:

- Default run/call healing MUST bypass only overlay-file installation. It MUST NOT create an overlay directory, delegate stamp or dummy installer, invoke an installer override, or rewrite the healing policy to `off`.
- Readiness and explicit verification MUST still observe the real runtime through the declared verifier and existing runtime checks. A missing or failed bridge MUST remain a failure; declaration alone is not live proof.
- Existing shared install/cleanup helpers, when exposed by a host, MUST report that no checkout overlay operation is needed and perform no file mutation. They MUST NOT certify runtime readiness or remove a prior overlay. No new public install/cleanup command is introduced.
- Launch, reload, owned stop, signals, cancellation, diagnostics, resource leases, recording and HUD behavior MUST retain their existing contracts. Capture still requires the recorder for the declared target; this declaration supplies no recorder or evidence exemption.

Overlay runtimes MUST retain existing installation, delegate validation, cleanup and bounded healing. Explicit `--heal off` retains its reproduction-preserving behavior for either form; it is not the default-healing compatibility test.

The public addition is the `AdapterHarness` discriminator in `@farmslot/adapter-sdk`, consumed by project providers and shared CLI handlers. Existing `defineAdapter` and `createAdapterRegistry().register` validate the same contract; no second parser, registry, host callback or CLI flag is added. Audiolab consumes the built-in form. Project providers remain responsible for bridge implementation and verification; shared code owns orchestration.

The SDK and CLI MUST ship compatible pre-1.0 minor versions before a provider adopts the new form. Providers MUST pin the qualified package versions, and rollout MUST qualify the actual shared host as well as the provider installation. The SDK ABI and artifact schema remain unchanged; old hosts are not certified for built-in providers. No SDK rename, compatibility alias or recorder migration belongs to this amendment.

Acceptance MUST prove default run and call on a real built-in UI bridge without overlay mutation, real verification failure when that bridge is unavailable, existing overlay install/cleanup and default-healing parity, malformed-declaration refusal, and unchanged explicit heal-off behavior. Use the public project loader and a registered owned target, then verify the released package/host combination. Unit tests alone do not close the live gate. The shared engine remains the sole trace, claim and artifact writer.

### Log view composition

`ProjectProvider.commandOptions.logs` MAY supply `LogsCommandOptions` from `@farmslot/recipe-cli/harness`. Its consumers are the shared `handleLogs` and project provider composition. The public types are:

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

For compact display, the host forwards `RECIPE_LOG_UI_MODE` or `compact` to the provider hook. The project's existing event classification, formatting, count normalization and mode behavior MUST be preserved through the reused helper; this migration does not reinterpret zero or environment values. A runtime without a compact hook MUST retain the existing bounded 20-line default and opt-in `--follow`; it MUST refuse explicit `--events` as unsupported. Explicit `--lines` or `--follow` selects the existing raw-line path; `--events` with explicit raw-line selectors MUST refuse conflicting selection. `--full` keeps its existing raw precedence. The canonical `recipe-project.ts` grammar MUST register `--events <count>` and `--window`. It MUST distinguish an operator-supplied `--lines` from an omitted option: remove the Commander default and retain 20 in the handler, so invocation serialization cannot turn omission into an explicit raw selector. Regenerate the reference from that grammar. An absent window hook is an explicit unsupported operation, never a success.

The project provider MUST extract the compact/window calls once from its old handler into provider helpers, using the existing asynchronous streaming primitive. Both entrypoints may consume those helpers during Phase 2. A helper MUST NOT execute the legacy project logs command or delegate to the legacy handler. Provider grammar still runs before factory effects. Status/doctor/conformance do not open viewers.

The remaining provider log viewer also serves native/browser launch and injected browser scripts. Phase 3 MUST inventory and migrate those callers before extracting shared viewer/session mechanics or deleting old paths. Completion requires one generic implementation, project classification/policy only in the provider, and no legacy CLI alias or forwarding shim.

Acceptance requires legacy/shared compact output and count/environment parity, no JSON follower, observed appends, failed-source refusal, full raw output, and PID-only INT/TERM/HUP with complete child closeout. Public-CLI cases MUST prove that omission calls the compact hook, explicit `--lines`/`--follow` select raw output, `--events` is not rejected because of a synthesized default, and raw/event conflicts refuse. No-hook cases MUST prove a bounded 20-line default that exits, opt-in follow, and explicit unsupported-event refusal. Window command tests MUST use a fake tmux executable and prove exact run targeting, no server/session creation or destruction, no focus changes, and missing-session refusal. Actual existing-session window proof remains a separately coordinated live gate under the coordinated rollout plan; fake commands do not prove that live behavior.

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

Recipe execution MUST default the HUD on where the target supports it. Live conformance MUST retain the proof-step observation required by that target and bind it to the execution, artifact manifest and live report's artifact hashes. On UI targets, a screenshot or recording shows the actual behavior; HUD intent is recommended so reviewers can identify the step. Missing HUD alone MUST NOT invalidate evidence, prevent a live pass or require a rerun. A registered handler, successful HUD command or trace marker alone does not establish behavioral proof. Headless or opaque targets record unsupported capture/HUD with the reason and MUST NOT receive fabricated UI proof. Selected capture requirements apply independently.

`--check-report` MUST recompute current identity/preflight and validate retained artifact bytes. Changed parameters, code, target, configuration or evidence MUST reject reuse. It MUST neither rerun the smoke nor overwrite the saved report. The report timestamp is provenance, not a grant of ongoing runtime readiness.

## 5. Selected-flow requirements and compatibility

The gateway MUST use the existing template selector and QA preset resolver. It MUST NOT infer requirements from a project name, numeric compatibility level or unrelated flow. Static Review keeps its existing template admission and MUST NOT acquire runtime QA requirements automatically.

Optional flat template metadata is:

| Field                             | Meaning                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `recipe_checks`                   | Recipe refs whose complete preflight is required                                                          |
| `recipe_actions`                  | Action handlers that must occur in the successfully preflighted smoke plans                               |
| `recipe_capture`                  | Require capture action support in those plans                                                             |
| `recipe_hud`                      | Require HUD action support in those plans                                                                 |
| `runtime_capabilities`            | Existing resource-provider IDs required by the selected flow                                              |
| `runtime_capability_requirements` | Scalar JSON array of authored proof modes/reasons/acquire inputs; see Amendment 1 below                   |
| `recipe_params`                   | Proposed JSON object carried as a scalar in frontmatter and passed through the existing `--param` grammar |

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

### Initial resource proof requirements, Amendment 1

This subsection is normative under the accepted [ADR-068 Amendment 1](../adr/068-project-recipe-binding-and-conformance.md#amendment-1-initial-resource-proof-requirements-2026-10-13). The amendment was approved on 2026-10-13; the accepted requirements above remain in force.

The optional flat metadata field `runtime_capability_requirements` MUST be a quoted scalar containing one JSON array. Each entry MUST use the existing `RuntimeCapabilityProofRequirement` shape from `@farmslot/protocol`:

```ts
interface RuntimeCapabilityProofRequirement {
  capabilityId: string;
  reason: string;
  mode: 'state' | 'visual' | 'mixed';
  parameters?: Record<string, unknown>;
}
```

For example, a flow reserving a catalog-declared browser for visual proof can declare:

```yaml
runtime_capabilities: [browser-cdp]
runtime_capability_requirements: '[{"capabilityId":"browser-cdp","reason":"Observe the selected application","mode":"visual"}]'
```

`recipeFlowRequirements` MUST decode this scalar once and expose its entries as `RecipeFlowRequirements.proofRequirements`. Missing metadata yields an empty array, not an inferred mode. The existing flat frontmatter parser MUST NOT become a nested YAML parser for this field. The accessor MUST reject invalid JSON, a non-array, unknown entry members, empty or padded provider IDs/reasons, invalid modes, duplicate provider IDs and non-object `parameters`. When the field is present, its provider IDs MUST exactly cover `runtime_capabilities`; extra or missing IDs refuse. An empty array is valid only with no declared resources. An absent field remains parseable for retained legacy tasks; it does not authorize first dispatch.

`parameters` are acquire inputs, distinct from `RecipeFlowRequirements.params`, which remain smoke inputs. The accessor MUST preserve JSON value types and MUST NOT interpret shell commands or interpolate strings. Portable template data MUST NOT contain machine names, absolute home paths, literal device identities or secrets. Node/device values come from the existing pool/slot binding and catalog authority. Provider parameter schemas, recording target identity and device ownership MUST be validated by their existing owners before any provider action. Omitted parameters mean no template-supplied inputs, not permission to guess missing required values.

The effective requirements MUST follow these rules:

1. Use only the canonically selected, revision-bound template for a fresh dispatch and the retained task/checklist declaration for an existing execution. Later template edits MUST NOT change that execution's obligations. Static Review remains independent of runtime requirements.
2. For each declared resource, use the matching requirement from an existing valid run/slot-owned proof plan when present. Its explicit retarget parameters remain authoritative; template defaults MUST NOT overwrite, merge into or undo them. Its mode MUST match the selected declaration's mode when that declaration is present. A mode conflict, duplicate requirement or foreign plan MUST refuse with the existing recovery guidance.
3. For a resource absent from the run plan, use its validated template requirement as the initial input. Preserve unrelated stored requirements and dependency parameters. An IDs-only declaration with no matching valid stored requirement MUST refuse with the resource ID and the missing authored proof mode before acquire/release or worker delivery. It MUST NOT infer mode from provider names, catalog availability, capture/HUD flags or recipe parameters.
4. Read-only preview/admission and compatibility display MUST consume the same pure validation result. When a run owner exists, admission MUST resolve modes against that run's valid stored plan per rules 2 and 3, including warm/nudge reuse. A resource satisfied by a valid stored requirement MUST NOT appear in `missingRequirements`. A run-less preview MUST display an IDs-only resource as requiring an authored mode; initial dispatch without one still refuses under rule 3. These reads MUST NOT create/update a plan, acquire a resource or execute its health/repair hooks. Display the required mode and concrete missing/conflicting requirement; a valid declaration is at most `declared`, never acquired ownership or verified live evidence.
5. After core prepare and target binding, the ADR-065 consumer MUST pass the effective requirements through the existing posture/registry path. Only that path may persist the existing proof plan and acquire resources. Existing schema/target checks, dependency ordering, parameter freezing, ownership, health, rollback and generation/restart fences remain mandatory. A valid mode MUST NOT bypass another refusal.

No additional proof-plan representation, store, CLI flag or project-specific acquisition loop is introduced. ADR-068 owns the declaration/accessor, read-only admission and shared display projection; ADR-065 owns its acquisition/recovery consumer. Harnesses retain provider schema/action extensions and inherit this behavior. `RecipeFlowRequirements.proofRequirements` and the extended `recipeFlowRequirements` are protocol exports consumed by those gateway paths; clients consume the shared compatibility result. This additive pre-1.0 API requires a minor protocol release and coordinated consumer pins, with the existing reviewed-release and registry gates. No conformance report schema or proof-mode semantics change.

Acceptance MUST cover a first dispatch with no pre-created plan, each authored mode, explicit acquire inputs and omitted optional inputs, malformed/partial/duplicate declarations, provider-schema/target refusals, zero preview effects, retained IDs-only recovery and warm/nudge admission with a valid stored plan, preserved explicit retargets, mode conflicts, and pinned declarations across replay/restart. A live gateway proof MUST start without a plan or held lease and observe acquisition plus health before worker delivery, using one real owned provider and normal cleanup. A pre-seeded plan or mocked acquisition alone does not prove first-dispatch completion.

## 6. Library references and cutover

The final composed-library interface MUST resolve `<library>/<ref>` to the named library. A bare ref MUST resolve only when unique across the composed set; ambiguity MUST list candidates. Exact qualified-ref overrides follow declared source precedence and MUST retain winners and shadows in describe/conformance/provenance. Cross-library dependency closure, version requirements and trust MUST be checked before effects.

The SDK contracts are `ProjectRuntime`, `ActionCatalog`, `ActionHandler` and `RecipeEngine`. Exports, imports and documentation MUST use these names consistently. Type renames MUST NOT independently rename protocol action IDs or unrelated wire fields. Compatibility aliases and deprecation shims MUST NOT remain.

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

| Owning package                 | Public surface                                                                                                                                         | Named consumer                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/adapter-sdk`        | Runtime/ActionCatalog contracts; optional `AdapterReadiness.recorder` until the coordinated naming cutover                                             | Project recorder readiness and other project runtime providers                                                                |
| `@farmslot/recipe-cli/harness` | Existing `resolveProjectContext`, `loadProjectProvider`, `withProjectRecipeHost`, `ProjectProvider`; optional doctor/status/stop/logs `commandOptions` | Public CLI and executable project providers                                                                                   |
| `@farmslot/recipe-cli/harness` | Shared `handleDoctor`, `handleLaunch`, `LaunchCommandOptions`, `handleLogs`, status/reload/stop handlers                                               | Public lifecycle CLI; harnesses inherit mechanics and supply runtime hooks                                                    |
| `@farmslot/recipe-cli/harness` | `LogsCommandOptions`, `LogsViewRequest`, `LogsWindowRequest`, `LogsWindowResult`                                                                       | Shared logs handler and project compact/window provider helpers; same pre-1.0 release policy below                            |
| `@farmslot/recipe-cli/harness` | `DoctorFixResult`, asynchronous doctor repair contract, `doctorReady`, `renderDoctorRecorder`                                                          | Shared readiness and project doctor composition                                                                               |
| `@farmslot/recipe-cli/harness` | `HarnessHost.doctorCommand`, host journal configuration, `readLatestProofJournal`                                                                      | Public recovery hints, status and artifact defaults                                                                           |
| `@farmslot/recipe-cli/harness` | Existing conformance identity/check/write/reuse APIs and extended runtime-proof validation                                                             | Root doctor and retained evidence verification                                                                                |
| `@farmslot/recipe-cli/harness` | Existing contained-path helper exposed as `isPathWithin`                                                                                               | Root doctor's retained artifact containment check                                                                             |
| `@farmslot/recipe-runner`      | Existing graph/library/trust APIs and `digestFileWithinRoot`                                                                                           | Default engine and artifact-byte binding                                                                                      |
| `@farmslot/protocol`           | `ProjectRecipeConfig.checks` and its existing declaration validator/schema                                                                             | Project packs declare default static invocations; the resolved binding and root doctor consume them                           |
| `@farmslot/protocol`           | `RecipeConformanceLiveEvidence`, report/check/scope types, `RecipeFlowRequirements`, `RecipeProjectCompatibility`, `conformanceChecksPass`             | CLI, gateway and compatibility consumers                                                                                      |
| `@farmslot/protocol`           | Proposed shared `recipeFlowRequirements` and `recipeProjectCompatibility` validation/projection                                                        | Gateway selected-flow admission; thin clients consume the resulting model                                                     |
| `@farmslot/protocol`           | `RecipeFlowRequirements.proofRequirements` and `resolveRecipeProofRequirements`                                                                        | Gateway admission and ADR-065 preparation share declaration/stored-plan precedence; clients consume required-mode diagnostics |

Gateway preview carries optional `recipeCompatibility`. The existing hosted hook result may carry a validated conformance report during migration. Internal conformance options MUST NOT be supplied by untrusted wire fields or bypass project/slot matching, pool environment, cancellation and closeout tracking.

Each project retains its own funding, fixture, plugin, device and collector policy. Its provider consumes shared command options and optional recorder readiness; its engine consumes the same scoped trust/cancellation path. Other harnesses can omit unsupported hooks and inherit the default engine. They MUST NOT copy generic orchestration to fill an absent capability.

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
| Live conformance     | Actual effect, positive assertion, authored cleanup assertion, complete validated artifact bytes, no lease takeover; captured proof-step behavior verified; HUD intent recommended on supported targets, explicit capture/HUD support recorded       |
| Selected flow        | Static review independent of runtime QA; required recipe/action/resource/parameter failures; no cross-target or cross-domain verification                                                                                                            |
| UI                   | Actual browser interaction/rendering plus real gateway-backed dispatch evidence; late results cannot certify another selection                                                                                                                       |
| Tutorial/docs        | A fresh reader follows only the tutorial through passing live conformance and one real dispatched run reaching its gate; every point of confusion becomes a doc fix                                                                                  |
| Cutover              | Complete old-to-new/unused map, live differential outcomes and artifact shape, callers migrated, obsolete binaries/routes/aliases removed                                                                                                            |
| Release              | Exact-head independent approvals, green required CI, package/import/archive/registry checks, coordinated publication and installed validation                                                                                                        |

The target matrix MUST cover each declared project runtime and target independently, including headless, browser, native simulator and physical-device rows where supported. Each phase needs a real dispatch reaching its gate for every adopter and selected flow. A verified row does not establish another row. Record baseline failures and unresolved targets without inflating evidence.

Unit/fixture tests support regression diagnosis but cannot replace those live rows. Default tests must stay under five seconds each and suites under five minutes; longer runtime proof belongs in the manual live tier. Tests MUST NOT start or kill a real tmux server. No shared build output may be rewritten under readers.

## Shared helper commands

**Status:** Accepted under ADR-068 Amendment 3. Implementation: [#1136](https://github.com/deeeed/farmslot/pull/1136). Installed consumers require the matching shared-package release.

### Public surface

| Canonical command                                               | Replaces                                       | Named consumer                                                  |
| --------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `farmslot task init`                                            | Project `task init` and `pin`                  | Task-template initialization and executable-resolution wrappers |
| `farmslot task verify`                                          | Private executable/receipt verification        | Task execution wrappers before invoking the frozen entry        |
| `farmslot task <mark\|closeout>`                                | Project `checklist mark`, `checklist closeout` | Generated task markers and closeout wrappers                    |
| `farmslot review <checklist\|domain>`                           | Project `review checklist`, `domain`           | Review workflows and domain-selection callers                   |
| `farmslot recipe quality <build\|plan\|advise\|advisor-status>` | Project `recipe-quality` operations            | Recipe authoring and quality-artifact consumers                 |

The canonical grammar MUST retain each referenced operation's argument mapping, output fields, exit codes and refusal behavior. It MUST preserve task/template selection, role-specific checklist and signal targets, subtask handling, incremental review base/since ranges, domain and parity resolution, quality guidance and explicit advisor policy. Root controls retain their meanings. Validation MUST precede provider effects; generated help and references MUST use that grammar. There MUST be no second public `checklist` or `recipe-quality` alias.

`@farmslot/recipe-cli/harness` owns these additive provider options and exports, consumed by the root CLI and project provider composition:

| Surface                                                                      | Contract                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ProjectProvider.commandOptions.task?: ProjectTaskCommandOptions`            | Extends `TaskInitCommandOptions` and `ChecklistCommandOptions`, with required `stepGates: readonly ChecklistStepGate[]`              |
| `ProjectProvider.commandOptions.recipeQuality?: RecipeQualityCommandOptions` | Existing builder and optional advisor subcommands; `guidance?: string` carries project quality text                                  |
| `ProjectProvider.commandOptions.review?: ReviewCommandOptions`               | Project rule data: `baseRules?: string`, `runtimeIds?: readonly string[]`, and `parityRuntimeIds?: Readonly<Record<string, string>>` |

Generic parsing, task-directory production, marking, quality validation, domain matching and review rendering MUST have one shared implementation. Existing template/library resolution remains authoritative. Providers retain project gate predicates, closeout policy, supported runtime IDs, parity mappings and rule text. They MUST NOT invoke their retired CLI or copy a shared handler.

`ReviewCommandOptions.parity` MAY supply the existing project reference resolution and parity rules. The synchronous callback receives `{ runtime, target, hasParityGuide }` from the resolved binding and authorized library. It returns `steps: readonly string[]`, optional `reference: { adapter: string; root: string; source: string }` and optional `referenceMissing: string`. The MetaMask provider consumes this hook to reuse configured/sibling checkout discovery and its reference-read-only and consumer-compile rules before migrating review callers. The shared handler renders the returned rules and retains the reference metadata and diagnostic in JSON; it MUST NOT substitute environment-only resolution for an explicit project result. Without this callback, existing parity mappings and output remain unchanged. The hook MUST remain read-only and MUST NOT acquire resources, fetch libraries or modify reference checkouts.

### Task identity and gates

Task initialization MUST freeze the actual Farmslot executable and implementation identity alongside the existing resolved provider, library and configuration identities in the task's execution provenance. The shared producer and provenance verification belong to `@farmslot/agent-runtime`; the recipe host supplies its existing binding and identity data. A provider package MUST NOT be recorded as the CLI executable. New wrappers MUST use the shared verifier, replacing their private resolver implementation.

`@farmslot/agent-runtime`'s task producer owns pin creation and retention. The existing project `mm-harness pin` implementation MUST move/generalize there, with package and source selection supplied by the resolved binding. The CLI distribution/layout comes from the immutable snapshot installation stage in `scripts/deploy-node.sh`; task pinning retains that verified distribution and its dependencies, rather than creating a second CLI installer. `task init` owns this operation. RecipeCook's executable resolver moves to `task init`/`task verify`; its private pin implementation and the standalone `mm-harness pin` route retire after caller migration.

Every frozen implementation input MUST be retained immutably for the task lifetime before generating the marker and receipt: CLI, required shared implementations, provider code/dependencies, canonical libraries and selected configuration bytes. Reuse package installations and task-owned input snapshots; paths to mutable working checkouts alone are insufficient. This adds no global registry. Global CLI pruning, provider rollouts, library pulls and mutable pool updates MUST leave the selected retained inputs usable. Task callbacks resolve those retained provider/library inputs while product and task-recipe source remain editable.

The existing `artifacts/harness-provenance.json` receipt retains its `schemaVersion`, `package`, `source`, `resolvedExecutable`, `entrySha256`, `packageTreeSha256` and `recordedAt` fields and their meanings. New initialization adds `bindingIdentity: TaskRecipeBindingIdentity | null`. `null` means an unbound static task, not an omitted project check. A resolved project binding MUST NOT be discarded to obtain that mode. Missing identity in an older receipt MUST NOT be interpreted as a new unbound task.

`TaskRecipeBindingIdentity` projects the existing `RecipeConformanceIdentity` fields `project`, `app`, `domain`, `adapter`, `target`, `provider`, `implementation`, `libraries` and `configuration`. It excludes `checkout`, `invocations`, `selection` and `trustDigest`: ordinary source and task-recipe edits MUST remain possible. Per-execution reports still bind the current checkout, invocation, resource selection and authorization. The host reconstructs expected tooling identity from retained selected inputs, so new pool defaults MUST NOT reselect a retained task's provider. Configuration verification uses the retained recipe-binding inputs, rather than later unrelated edits to mutable pool records.

`@farmslot/agent-runtime` exports `TaskRecipeBindingIdentity`, `TaskExecutionProvenance` and `verifyTaskExecutionProvenance(taskDir, expectedBindingIdentity)`. The verifier returns the checked receipt or refuses before mutation; it checks the recorded executable/package/source bytes and the supplied tooling identity. Root `task verify`, marking and closeout consume it. Execution wrappers use `task verify --json` through the trusted installed CLI before invoking the verified frozen entry; they MUST NOT first execute a path supplied by an unchecked receipt. Recorded sources remain subject to existing configured/operator-authorized source policy; self-declared hashes alone do not authorize new executable code.

Generated markers MUST target the frozen CLI's `task mark` operation. A bound project's provider MUST opt into task composition through `commandOptions.task` with an explicit `stepGates` array; absence is unsupported. A provider without project gates declares `[]`. A provider with existing gated templates MUST supply its existing predicates and closeout policy, verified by old/new refusal checks; it cannot replace them with `[]`. The framework uses these existing provider declarations, not inferred or new template gate metadata. Explicit caller options retain their existing authority; they MUST NOT waive required gates. Marking and closeout MUST verify recorded identities before changing task state and preserve project checks, required quality evidence, closeout refusals and explicit sharing consent. Missing required provider hooks MUST refuse; an ungated generic fallback is invalid. Helpers MUST NOT acquire resources, repair a runtime or manufacture recipe proof to satisfy a gate. Unbound static task creation remains supported with explicit template inputs; it does not imply project support.

Existing tasks and receipts MUST retain their recorded meaning. The receipt's `schemaVersion` remains `1` for the additive field. For older receipts lacking `bindingIdentity`, new `task verify`, mark and closeout MUST return a typed legacy-receipt refusal without mutation; the original pinned marker remains unchanged and usable. The new commands MUST NOT automatically forward to a legacy CLI.

Verification MUST NOT silently repin a task, rewrite markers, regenerate acceptance identities or replace retained evidence. This amendment introduces no in-place identity upgrade or implicit rebinding on resume. Missing or changed retained inputs refuse; restoring their exact recorded bytes through the owning installation mechanism preserves the receipt. Artifact schemas and selected engine publication remain unchanged.

### Equivalence and deletion

Before moving a caller, its replacement MUST prove the same positive result and refusal cases. Checks include rejected gates leaving checklist/signal state untouched; role and subtask targets; ordinary source edits; usable pins after global CLI pruning, provider rollout and library pull; refused tooling identity drift; review domain/parity/base/since output; invalid quality input writing nothing; and advisor opt-out making no model request. Builder success alone is not a quality judgment.

Help, task verification, template selection and advisor status MUST preserve their read-only behavior. Explicit review generation and advice retain only their existing declared effects and authorization.

Every active pack, skill, template, library and completion caller MUST move or be explicitly retired before its producer is deleted. Other legacy operations retain their existing disposition and equivalence requirements. In particular, `pr-body render` maps to `recipe artifacts --format markdown` only after authored prose and provenance are preserved; help/JSON and review-guide callers move to canonical command help with the existing review/quality data. Settings and provisioning also retain their named replacement requirements. This amendment does not authorize dropping them. Final acceptance still requires the original project/target, real-dispatch and tutorial checks.

## Authored task Markdown

**Status:** Proposed under ADR-068 Amendment 4. Implementation follows reviewed content approval in the same caller-parity PR.

### Public surface

| Surface                                                                                                                        | Argument mapping and named consumer                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farmslot recipe artifacts <task> --format markdown`                                                                           | Replaces `pr-body render <task>` for pack commands and recipe PR-description skills. Preserves authored sections and generated evidence rather than listing filenames.                                                                                                  |
| `--command <text>`                                                                                                             | Preserves the displayed invocation for recipe PR-description skills. Display only; MUST NOT execute it. Requires Markdown format.                                                                                                                                       |
| `--out <file>`                                                                                                                 | Preserves explicit output selection for skills and the gateway's private temporary output. Requires Markdown format. No implicit output file is written; callers needing the old default pass `<task>/artifacts/pr-body.md` explicitly.                                 |
| `--json`                                                                                                                       | Retains inspection's `artifactDir`, `summary`, `manifest` and optional `validation`. Authored rendering adds `sections`, `recipe`, `run`, `workflow`, optional `out`, and the Markdown `body` when no output file is requested. Paths identify the files actually read. |
| `renderTaskArtifactsMarkdown`, `TaskArtifactsMarkdownInput`, `TaskArtifactsMarkdownResult` from `@farmslot/recipe-cli/harness` | One renderer consumed by the root CLI; project wrappers migrate to that CLI. Input is `{ taskDir, artifactDir?, command? }`. Result is `{ body, sections, recipe, run, workflow }`; file metadata retains its task-relative `path`, and recipe metadata its node count. |

The additive SDK API requires a reviewed minor release and installed consumer checks. The renderer MUST remain read-only and MUST NOT resolve another attempt after the caller supplies `artifactDir`. The root CLI owns authoritative attempt selection and existing package validation. No provider import is required to render an explicit task.

### Rendering and refusals

Read `artifacts/pr-description.md`. Preserve authored sections, images, checklist contents and their order. Replace pasted Validation Recipe, Validation Logs and optional Recipe Workflow sections, inserting generated sections before the first checklist or appending when none exists. Retain graph and older array node counts, optional `artifacts/workflow.mmd`, escaped details summaries and fences longer than embedded backtick runs. Normalize line endings to LF.

For a selected retained attempt, render its captured recipe and report, never a mutable draft or older report. Retain package identity and provenance in Markdown and JSON. A missing, invalid, escaping or incomplete selected package MUST refuse without fallback. Use the existing retained-attempt reader and contained artifact reader; do not add another selection or filesystem policy.

Static tasks MAY render their authored recipe or existing legacy report without a package, with explicit not-applicable sections for missing files. This MUST NOT imply validated or live proof. `--validate` still requires a complete valid package and runner provenance. Existing explicit-package inspection and Markdown listing remain supported.

Default rendering writes only stdout. With `--out`, write the rendered body only after requested validation passes. Refuse outputs that overwrite authored inputs, selection metadata or retained attempt evidence. Rendering MUST NOT change task identities, checklist/signal state, attempt selection or publication authority. Gateway template checks and publication remain separate and consume the returned temporary output bytes.

Before deletion, compare old/new static and selected-attempt rendering, authored sections, output/JSON consumers, invalid selection and validation refusals. Migrate active pack, gateway and skill callers and prove installed behavior; remove the old renderer and route without forwarding wrappers.
