# Recipe Runner Protocol

The runner contract connects [Recipe Protocol v1](recipe-protocol-v1.md) to a project's real runtime. It standardizes discovery, execution, trust, and evidence without moving product logic into Farmslot.

## Required pieces

| Piece            | Responsibility                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Recipe           | Declares `$schema`, workflow, optional title/description, parameters, proof targets, and teardown |
| Action manifest  | Declares supported actions, strict parameter schemas, result cases, examples, and capabilities    |
| Adapter          | Implements each declared action against the selected runtime                                      |
| Library          | Publishes named, optionally adapter-specific recipes                                              |
| Runner command   | Receives recipe, target, parameters, and artifact directory                                       |
| Artifact package | Retains exact inputs, resolution, trace, verdict, observations, and proof                         |

## Action manifest

An action manifest is the runner's public capability contract. An action declaration includes:

- stable name and concise description;
- strict JSON-Schema-shaped parameters;
- optional adapter names when support differs by adapter;
- optional `adapter_schemas` that narrow parameters for individual declared adapters;
- capabilities required before execution;
- finite `result_cases` when the action can branch;
- one or more valid examples for exact-detail discovery.

Namespaced project actions such as `metamask.wallet.ensure_unlocked` remain project-owned. Official actions stay small and platform-neutral.

The manifest is authoritative. Unknown actions, fields, and result cases fail validation. When an action declares `adapters`, validation rejects other active adapters before execution and names the supported alternatives. Adapter-specific schemas refine the shared schema during planning, and every manifest example must satisfy every declared refinement.
The published Action Manifest schema at `https://farmslot.io/schemas/action-manifest-v1.schema.json` provides editor structure and completion; runtime validation also enforces cross-field relationships such as required-property membership and enum/default value types.

## Discovery

Runners expose progressive disclosure:

```sh
farmslot-recipe run --list --adapter <adapter> --json
farmslot-recipe run <recipe> --describe --adapter <adapter> --json
```

List output contains only selection facts and exact recipe detail expands only when requested. Action discovery belongs to the project runner because manifests and adapters are project-owned.

## Execution contract

Before side effects, the runner:

1. validates the root recipe;
2. indexes ordered libraries and selects the adapter variant;
3. resolves and validates the complete static call graph;
4. applies parameter defaults, then validates values;
5. checks action compatibility and capabilities;
6. binds trust approval to the exact plan.

During execution, adapters return only `case`, `output`, `artifacts`, and `observations`. The recipe graph owns transitions and final status. Declared teardown runs after main success or failure.

## Artifact contract

A complete run contains:

```text
recipe.json
recipe-resolution.json
resolved-recipes/<sha256>.recipe.json
summary.json
trace.json
artifact-manifest.json
```

The manifest may index screenshots, video, logs, and domain evidence. Every file stays under the artifact root. Package validation revalidates recipe documents, dependency digests, call edges, reachability, and file presence.

## Failure contract

Failures identify the layer and provide a next action. Machine mode uses stable codes rather than prose. A runner must fail before side effects for invalid documents, unresolved dependencies, parameter errors, capability denial, or trust denial.

Runtime failures retain the partial trace and still execute declared teardown when possible. Runners never convert missing evidence into a passing claim.

Failed trace entries carry one explicit `cause_class`: `subject`, `harness`,
`environment`, or `unknown`. Successful entries omit it. `summary.json` retains
all four cause counts, and package validation requires them to reconcile with
the trace.

## Suite evidence

Multi-run coverage uses standalone Recipe Suite Scope v1 and Recipe Suite
Result v1 documents. A scope freezes a non-empty set of opaque case IDs before
execution. Its result must resolve every ID exactly once with either a retained
run-summary verdict or an explicit non-execution reason.

Suite validation checks the canonical scope digest, summary digests and
statuses, exact totals, safe paths, ordering dependencies, and completeness.
`oversight` keeps an omission machine-readable but makes the suite invalid. The
harness finalizer aggregates completed runs; it does not schedule or retry them.

## Command Center replay options

Command Center may replay a validated recipe, follow its live trace, and render artifacts. It must use the same runner contract and artifact package as the CLI. UI replay is a presentation surface, not a second executor.

Video capture is optional evidence. If enabled, its capability and destination are included in the trust plan and its output is indexed in `artifact-manifest.json`.

## Project integration

A project needs only:

1. an install or injection hook for its runner;
2. a strict action manifest;
3. adapter implementations for declared actions;
4. one minimal smoke recipe;
5. a verify command that validates the manifest, recipe, and produced artifacts.

See [New project recipe support](new-project-recipe-support.md) for the onboarding sequence.
