# ADR-049: Agent Execution Template Selection

**Status:** Accepted
**Date:** 2026-07-09

## Context

Farmslot dispatch and standalone agent skills both select the Markdown
instructions that drive a task. Keeping separate worker prompts and skill
checklists creates drift, hides provenance, and makes team libraries harder to
reuse.

The shared artifact should remain a readable Markdown checklist. Runtime
setup, fixtures, app control, recipes, and evidence protocols belong to their
existing layers rather than template metadata.

## Decision

Use one generic execution-template catalog and selector from
`@farmslot/agent-runtime`.

The same Markdown template can be selected through Farmslot or materialized by
a standalone skill. Farmslot snapshots the selected content before dispatch;
workers never read the control-plane source after dispatch begins.

Farmslot core owns generic discovery, selection, snapshotting, and provenance.
Project packs configure sources, defaults, domains, and environment. Skills
own canonical workflow checklists. Team libraries may add domain checklists,
recipes, and actions. `mm-harness` provides only the thin command boundary
needed by MetaMask skills.

## Template contract

An execution template is one Markdown file with optional frontmatter:

```markdown
---
runMode: autonomous
platforms: [mobile, ios, android]
labels: [runtime-proof]
---

# Fix a Mobile bug with runtime proof

- [ ] Reproduce the reported behavior in the real app.
- [ ] Implement the smallest correct fix.
- [ ] Re-run the proof and capture evidence.
```

Supported frontmatter fields are:

Platform lists include the logical family and any raw slot aliases the template
supports (`mobile, ios, android`; `extension, chrome-extension`; `core, cli`).

| Field       | Inference when absent                                    |
| ----------- | -------------------------------------------------------- |
| `id`        | Catalog-relative path without `.md`                      |
| `title`     | First heading or humanized filename                      |
| `flow`      | Flow-tree directory or verified worker-template metadata |
| `version`   | Omitted from portable provenance                         |
| `runMode`   | Filename convention when available; otherwise wildcard   |
| `platforms` | `["*"]`                                                  |
| `labels`    | `[]`                                                     |

Frontmatter does not define domain, fixtures, preflight, recipes, device
selection, or runtime commands.

Configured flow-tree sources use `<flow>/<variant>.md`, producing an id such as
`fix-bug/autonomous.mobile`. Project worker templates remain a supported
`worker-flat` source.

Domains use only exact `domain:<name>` labels. Source configuration adds those
labels to every template from that source; authors do not add a separate
frontmatter domain field.

## Sources and precedence

Projects may declare optional `execution_templates.sources` and
`execution_templates.defaults`:

```json
{
  "execution_templates": {
    "sources": [
      {
        "id": "package:consensys-recipe-cook",
        "kind": "package",
        "root": { "env": "CONSENSYS_RECIPE_COOK_ROOT" },
        "subpath": "references/templates"
      },
      {
        "id": "team:trading",
        "kind": "workspace",
        "root": { "env": "PERPS_RECIPE_LIBRARY_ROOT" },
        "subpath": "checklists",
        "domains": ["trading"]
      }
    ],
    "defaults": [
      {
        "when": {
          "flow": "fix-bug",
          "platform": "mobile",
          "runMode": "autonomous",
          "domain": "trading"
        },
        "templateId": "fix-bug/sentry-cuf-autonomous.mobile"
      }
    ]
  }
}
```

Configured roots are either project-relative paths or environment references.
They are canonicalized and constrained before scanning. Missing optional roots
are reported as unavailable only when the catalog is requested.

Duplicate ids resolve by the existing source precedence:

```text
custom > project > workspace > user > package > fallback
```

Precedence resolves only duplicate ids. It never chooses between distinct
compatible templates. Shadowing remains visible in catalog diagnostics.

## Domain and selection rules

Every phase uses one effective domain:

```text
explicit run/prepare domain ?? slot domain ?? pool domain ?? none
```

That value controls source participation, exact `domain:*` filtering,
configured defaults, `{{domain}}` expansion, and `command_env.domains`.

For configured catalogs, compatibility requires:

- exact flow;
- requested platform or `*`;
- exact run mode or no declared run mode;
- no domain label, or the exact requested `domain:<name>` label.

Selection is deterministic:

1. explicit compatible id;
2. first matching configured default;
3. the sole exact-domain candidate;
4. the sole general candidate;
5. otherwise fail with exact compatible ids.

Source precedence, caller order, filesystem order, and fuzzy matching never
select between different compatible ids.

Projects without `execution_templates` retain the existing worker-template
listing and selection behavior. This no-config path is the generic
compatibility baseline, including existing interactive and domain-filename
behavior.

## Domain-scoped environment

`command_env.domains` extends the existing project environment contract:

```json
{
  "command_env": {
    "set": { "SHARED_SETTING": "value" },
    "domains": {
      "trading": {
        "set": {
          "RECIPE_LIBRARY_PATH": "trading={{trading_library_repo}}"
        }
      }
    }
  }
}
```

Base mutations apply first and the effective-domain overlay second. Only
project-declared domains apply mutations. Dispatch callers select a domain but
cannot supply environment names or values. The same environment reaches
prepare hooks, lifecycle commands, and worker launch.

Only domain `set` values gain safe slot/project placeholder expansion. Invalid
variable names or unresolved placeholders fail before command execution.
Environment values are never copied into structured provenance.

## Snapshot and provenance

Portable provenance identifies the source Markdown and the exact task copy:

```json
{
  "executionTemplate": {
    "id": "fix-bug/sentry-cuf-autonomous.mobile",
    "sourceId": "team:trading",
    "flow": "fix-bug",
    "runMode": "autonomous",
    "platforms": ["mobile"],
    "labels": ["domain:trading"],
    "relativePath": "fix-bug/sentry-cuf-autonomous.mobile.md",
    "sourceRevision": "<git revision when available>",
    "sha256": "<source Markdown digest>",
    "renderedSha256": "<materialized checklist digest>"
  }
}
```

`relativePath` is relative to the configured scan root. `sourceRevision` is
derived when possible. `version` appears only when explicitly declared.
Portable run, replay, eval, and export packages never contain absolute source
paths, project paths, or environment values.

The task directory contains the immutable rendered checklist, its provenance
record, and the existing task lifecycle artifacts.

## Launch surfaces

Gateway, API, CLI, and Command Center use the same capability for:

```text
project + flow + platform + runMode + effective domain
```

Preview and create resolve the same id and digest; create validates again
before slot mutation. Command Center keeps run mode and execution template as
separate controls, refreshes options when an input changes, and displays source
and digest provenance.

The standalone `recipe-cook` skill calls `mm-harness execution-template`,
which delegates to the published `@farmslot/agent-runtime`. The skill contains
no second resolver. In Farmslot-hosted mode it resumes the already materialized
checklist and does not create another task.

## Ownership boundaries

| Layer            | Owns                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| Farmslot core    | Generic catalog, selection, snapshot, provenance, launch surfaces    |
| Project pack     | Sources, defaults, domains, environment, fixtures, ports, hooks      |
| Consensys skills | Canonical MetaMask workflow checklists and direct entry point        |
| `mm-harness`     | MetaMask app control, recipe/action execution, thin template command |
| Team library     | Domain actions, composable recipes, optional distinct checklists     |
| Product repo     | Product UI, controllers, routes, test ids, business logic            |

No MetaMask domain, team, route, or recipe behavior belongs in Farmslot core.

## Consequences

- Direct and hosted workflows share one immutable Markdown contract.
- Domain libraries can extend a project without copying workflow manuals.
- Provenance exposes source revision and content digests without leaking local
  paths or environment values.
- Existing generic farms remain unchanged until they opt into a configured
  catalog.
- A configured catalog must provide explicit defaults where more than one
  compatible template exists.

## Non-goals

- Recipe or action protocol changes.
- Checklist sidecar manifests.
- A remote library registry or marketplace.
- Caller-supplied environment values.
- Fuzzy template selection.
- Product UI, controller, or route changes.

## Related

- [ADR-034](034-recipe-protocol-v1.md) — Recipe Protocol v1
- [ADR-045](045-worker-terminal-contract.md) — Worker Terminal Contract
- [ADR-030](030-replay-provenance-and-reference-evals.md) — portable replay provenance
