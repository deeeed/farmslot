# ADR-035: Node Support Bundles

**Status:** Accepted
**Date:** 2026-06-10
**Relates to:** [ADR-008](008-remote-communication.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-015](015-resource-streams.md)

## Context

Farmslot projects are intentionally project-agnostic. A simple project should be able to define hooks in `project.json` that run entirely inside the worker repo or use system tools, for example `yarn install`, `npm run dev`, or `curl localhost`. Those projects should not need any Farmslot-side file sync beyond normal fixtures.

Some complex integrations need extra Farmslot-owned helper files to prepare or validate a slot. Examples include projects whose hooks call project-owned preflight or recipe wrapper scripts under `projects/<name>-farm/`, plus shared Farmslot lifecycle helpers under root `scripts/`. Historically those helpers could be assumed to exist on every node under `~/farmslot-node/projects/...`. That created stale duplicated project folders on nodes and made prepare fail when the node copy drifted from the gateway copy.

## Decision

Introduce **optional node support bundles**: content-addressed, project-declared bundles of Farmslot-owned files that a node needs to execute project hooks.

Node support is **opt-in**. If a project's hooks do not reference Farmslot-owned helper files outside the worker repo, it declares nothing and syncs nothing.

Project configs that need support files declare them explicitly:

```jsonc
{
  "node_support": {
    "paths": [
      "scripts",
      "projects/example-mobile-farm/project.json",
      "projects/example-mobile-farm/scripts",
    ],
  },
}
```

There is no required common project folder layout. `scripts/`, `setup/`, `fixtures/`, and any other directory are just paths when a project declares them.

Hooks that need bundled support should reference the bundle location, not a global node clone:

```sh
bash {{node_support_dir}}/projects/example-mobile-farm/scripts/preflight.sh ...
```

## Responsibilities

### Gateway

- Owns the source of truth for `project.json` and declared support paths.
- Computes a support manifest and content hash from declared files.
- Validates enabled slots across supported nodes before runs.
- Ensures the node has the required bundle before executing hooks.

### Node

- Stores immutable bundles by hash, for example `~/farmslot-node/support/<hash>/`.
- Answers fast manifest/index checks such as `node.support.has(hash)`.
- Materializes uploads into a temporary directory, verifies them, then atomically publishes the bundle.
- Does not need to understand project semantics.

### Prepare

Prepare is a consumer, not the owner, of sync. It performs a mandatory `ensureSupport(hash)` gate before hook execution:

- if the node already has the expected hash, continue with no file copy;
- if the hash is missing, sync the declared sparse bundle and publish it atomically;
- if sync or verification fails, stop before mutating the worker repo.

Proactive sync on node connect is allowed later as an optimization, but it is not required for correctness. The correctness boundary is the prepare-time manifest gate.

## Sync and coherence model

1. Gateway computes the desired support manifest for the slot's project.
2. During prepare, gateway asks the node whether the content hash already exists.
3. If present, no sync occurs.
4. If missing, gateway uploads the bundle to a temporary node path.
5. Node verifies file count/hash, atomically renames into `support/<hash>`, and updates its index.
6. Hooks run with `{{node_support_dir}}` pointing at the immutable bundle.

Before hook execution, Farmslot refuses to proceed if the expected support hash is unavailable. This prevents incoherent state where a hook runs against stale or partially-synced helper files.

## Validation

Add a project-agnostic validation gate that checks all enabled slots across supported nodes:

- declared `node_support.paths` exist;
- hooks do not reference undeclared Farmslot-owned paths;
- simple projects without Farmslot-owned support refs need no `node_support` block;
- local and remote slot expansion produce the same logical support contract;
- no project-specific assumptions are embedded in gateway lifecycle code.

## Non-goals

- Do not mirror the full Farmslot repo to every node.
- Do not sync every `projects/*` folder to every node.
- Do not keep broad `projects/*` mirroring in node deploy as a hidden fallback.
- Do not assume every project has `scripts/`, `setup/`, or `fixtures/`.
- Do not use prepare as a general file replication mechanism.
- Do not make simple projects declare support bundles when their hooks only use repo-local or system commands.

## Migration

1. Keep backward-compatible inference only as a temporary warning path for existing projects.
2. Add explicit `node_support.paths` to complex integrations that call Farmslot-owned helper files.
3. Update those hooks to use `{{node_support_dir}}`.
4. Turn undeclared Farmslot-owned hook references from warnings into validation failures.
5. Remove stale global `~/farmslot-node/projects/*` dependencies from nodes.
