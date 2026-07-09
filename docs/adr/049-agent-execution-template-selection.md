# ADR-049: Agent Execution Template Selection

**Status:** Proposed
**Date:** 2026-07-09

## Context

Farmslot project packs and standalone agent skills both need to choose the
instructions that drive an agent through a task: fix a bug, build a feature,
review a PR, complete a PR, or run a domain-specific workflow.

Today this is split across two mechanisms:

1. Farmslot dispatch chooses worker templates such as `dev.md` or
   `dev-interactive.md`.
2. Standalone skills choose checklist/reference files such as basic or Perps,
   autonomous or interactive.

Those are really the same product concept: choose the agent execution template
for this task.

This decision should stay small. We do not need preflight requirements, runtime
setup, branch setup, harness status, or device selection in the template schema.
Those are launcher/orchestration concerns and should stay outside the reusable
template format.

## Decision

Standardize the existing Markdown worker-template mechanism so the same files
can be used by Farmslot dispatch and standalone skills.

This is not a new artifact type. It is the current `*.md` template/checklist
file with optional frontmatter for dispatch metadata. Farmslot may use the
frontmatter to filter/select templates and record provenance. Standalone skills
can ignore unsupported frontmatter and use the same Markdown body directly.

The shared catalog is just a resolver over those Markdown files.

The catalog answers:

- which templates exist;
- which flow/platform/mode each template is meant for;
- where the Markdown execution checklist/template lives;
- how to lint the file so checkboxes and optional frontmatter are easy to parse;
- how to create a new template quickly;
- what selected template was used for provenance.

It does **not** own deterministic preflight.

## Template Shape

The primary artifact is the Markdown execution checklist/template we already
use today. Metadata lives in optional frontmatter at the top of the same file,
mostly for Farmslot dispatch and provenance. We should avoid sidecar JSON/YAML
files unless a project has a real reason to generate a catalog mechanically.

Example:

```markdown
---
runMode: autonomous
platforms: [mobile]
labels: [perps, runtime-proof]
---

# Perps mobile fix-ticket v2

- [ ] Read the task file and identify the requested behavior.
- [ ] Inspect the current diff and relevant code paths.
- [ ] Reproduce or validate the issue.
- [ ] Implement the smallest correct fix.
- [ ] Run focused validation and attach evidence.
- [ ] Mark the task complete, blocked, or no-change.
```

Most fields are optional and can be inferred:

| Field       | Default inference                                               |
| ----------- | --------------------------------------------------------------- |
| `id`        | stable id from catalog-relative path without `.md`              |
| `title`     | humanized file basename or first heading                        |
| `flow`      | nearest catalog folder such as `dev`, `fix-ticket`, `review-pr` |
| `version`   | `1` unless frontmatter says otherwise                           |
| `runMode`   | dispatch context, filename, or folder convention when possible  |
| `platforms` | all platforms unless frontmatter narrows it                     |
| `labels`    | empty unless frontmatter provides them                          |

Most templates should need no frontmatter or only `runMode`. Domain labels,
platform filters, and explicit ids are optional conveniences for Farmslot
discovery/provenance. Skills should be able to use the body even when they do
not understand those fields.

The linter should validate only frontmatter, inferred metadata, and basic
template/checklist structure. It should not validate runtime setup, branch
state, harness state, slot state, fixture state, or evidence artifacts.

## Run Mode vs Template

Farmslot already has `run.mode`:

- `autonomous` — worker should proceed without in-flight human gates;
- `interactive` — worker may pause for operator steering or handoff;
- `validation` — validation/eval carrier mode.

ADR-049 keeps that field. It adds a separate selected template identity.

The UI should eventually expose two concepts:

1. **Run mode:** how the worker session behaves.
2. **Execution template:** what instructions the agent follows.

During migration, existing filenames map to implicit template ids:

| Legacy template      | Derived run mode | Derived template id      |
| -------------------- | ---------------- | ------------------------ |
| `dev.md`             | `autonomous`     | `legacy-dev-default`     |
| `dev-interactive.md` | `interactive`    | `legacy-dev-interactive` |
| `fix-bug.md`         | `autonomous`     | `legacy-fix-bug-default` |

Dispatch should record both values:

```json
{
  "mode": "interactive",
  "executionTemplate": {
    "id": "fix-ticket/perps-v2.mobile",
    "version": 2,
    "runMode": "interactive",
    "path": "templates/execution/fix-ticket/perps-v2.mobile.md",
    "hash": "<content hash>"
  }
}
```

Code that needs lifecycle behavior reads `run.mode`. Code that needs
authoring/provenance/eval identity reads `executionTemplate`.

## Catalog Locations

Templates can live in project packs, skill packs, or shared user/workspace
locations. The search path must be configurable; it must not rely on hardcoded
local machine paths. A shared location lets the same Markdown template drive a
Farmslot dispatch or a direct Consensys skills dispatch.

For the MetaMask adoption path, the intended shared surfaces are MetaMask farm
project packs, `mm-harness`, and `consensys-skills`. A default template should
be available to both Farmslot and direct skills dispatch, with domain overlays
such as Perps layered on top. The exact source of truth is deferred to the
implementation spec so the ADR does not hardcode package ownership too early.
The implementation should be scheduled from a backlog spec handoff that records
the current macwork absolute checkout paths for review context. Those paths are
not part of this contract and must not be hardcoded into runtime resolution.

Suggested resolver order:

1. project pack templates;
2. workspace shared templates;
3. user shared templates;
4. installed skill/package templates;
5. built-in fallback templates.

Example layout:

```text
templates/execution/
  fix-ticket/
    perps-v2.mobile.md
```

The resolver should report source, path, hash, and shadowing metadata. Dispatch
should copy or render the selected template into the task directory so a running
task is immutable even if a shared template changes later.

## Preflight Boundary

Preflight is intentionally outside this ADR's schema.

Examples of preflight work:

- checkout the correct repository;
- create or switch to an idempotent branch;
- update the branch against the configured base;
- sync skills or project overlays;
- render the task directory;
- resolve runner/harness paths;
- write runtime context;
- choose slot, device, platform, and prepare option;
- capture doctor/status snapshots;
- write baseline metadata artifacts.

Those steps may happen before dispatch, inside Farmslot orchestration, or inside
a standalone skill wrapper. The selected execution template may reference
preflight artifacts if they exist, but the template catalog does not define or
validate them.

## Tooling

Add small shared tooling focused on the authoring loop:

```bash
execution-template list --flow fix-ticket --platform mobile --run-mode autonomous
execution-template lint templates/execution/
execution-template new templates/execution/fix-ticket/perps-v2.mobile.md --from basic-mobile --run-mode autonomous
execution-template render --id perps-v2-mobile-fix --kind farmslot
execution-template render --id perps-v2-mobile-fix --kind skill
```

Required capabilities:

- `list` shows the effective catalog after project/workspace/user/skill lookup,
  including inferred id/title/flow/run mode/platforms/source path.
- `lint` validates that a Markdown file can be parsed deterministically by
  Farmslot and skills.
- `new` creates a valid starter Markdown template from a known-good built-in or
  project template.
- `render` materializes the selected template for a Farmslot task or direct
  skills dispatch.

Lint validates:

- optional frontmatter matches the schema;
- inferred `id` is unique in the effective catalog or intentionally overrides
  another source;
- checklist gates, when present, are ordered `[ ]` items;
- checkbox lines are parseable enough for progress tracking (`- [ ]` and
  `- [x]`);
- headings and frontmatter boundaries do not make the Markdown ambiguous;
- template files do not contain hardcoded local machine paths;
- declared flow/platform/run mode are internally consistent.

`new` creates one Markdown execution checklist/template with minimal
frontmatter. A new template should start from this generated file instead of
copying an arbitrary old worker prompt.

## Consumers

Farmslot dispatch and standalone skills should call the same template discovery
and linting library:

| Consumer                 | Behavior                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| Farmslot dispatch        | Lists matching templates, renders the selected template, records provenance. |
| Project worker templates | Remain supported; they are the compatibility baseline.                       |
| Standalone skills        | List/render the same Markdown templates into local task files.               |
| Eval/replay packages     | Record template id/version/path/hash as task metadata.                       |

## Relationship to Existing ADRs

- ADR-034 owns recipe/evidence protocol.
- ADR-045 owns terminal artifact enforcement.
- ADR-049 owns execution template discovery, schema, linting, authoring, and
  provenance.

## Consequences

Positive:

- The model matches the existing mechanism: choose which Markdown template
  drives the agent.
- Farmslot and skill workflows can share templates without copying whole worker
  prompts between systems.
- New templates are easy to add through `new` + `lint`.
- Run mode and template identity are no longer conflated.
- Provenance can record which template version drove a task.

Costs and risks:

- Adds a small optional metadata layer to files that already exist.
- Requires a resolver shared by Farmslot and skills.
- Existing template names need compatibility mapping where dispatch wants
  explicit ids/provenance.
- Template quality still depends on concise authoring; lint only catches
  structure and obvious contract violations.

## Non-goals

- Defining deterministic preflight.
- Replacing `run.mode`.
- Replacing the current Markdown worker-template mechanism.
- Defining recipe graph semantics; ADR-034 owns that.
- Defining terminal completion artifacts; ADR-045 owns that.

## Implementation Phases

1. **Frontmatter schema and linter:** add optional
   `agent-execution-template.v1` frontmatter schema plus lint for inferred
   metadata and Markdown checklist structure.
2. **Authoring tools:** add `list`, `lint`, and `new` for quick discovery,
   deterministic parsing validation, and starter template creation.
3. **Shared resolver:** support project/workspace/user/package search paths with
   source/hash/shadowing metadata.
4. **Skill integration:** replace bespoke checklist listing with the shared
   template lister while preserving current output compatibility and using the
   Markdown body directly.
5. **Farmslot dispatch integration:** expose dynamic templates separately from
   run mode and record selected template provenance.
6. **Migration:** catalog current `dev.md`, `dev-interactive.md`, and
   project-specific templates in place before moving or replacing any storage.

## Open Questions

- Should catalogs live under `templates/execution/` or another project-pack
  path?
- Should `flow` reuse existing Farmslot flow names exactly, or allow aliases
  such as `recipe-fix-ticket` that normalize to `fix-ticket`?
- Should template lint run in the existing worker-template quality command or
  as a separate command?
- Should the initial frontmatter schema be hosted immediately at
  `https://farmslot.io/schemas/agent-execution-template.v1.json`?
- How much of the current worker prompt envelope should remain outside the
  reusable template body?

## Related

- [ADR-034](034-recipe-protocol-v1.md) — Recipe Protocol v1
- [ADR-045](045-worker-terminal-contract.md) — Worker Terminal Contract
- [ADR-030](030-replay-provenance-and-reference-evals.md) — template provenance in eval packages
- [ROADMAP-next](../ROADMAP-next.md) — `@farmslot/skills` recipe-first adoption kit
