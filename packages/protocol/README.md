# @farmslot/protocol

Shared TypeScript contract for Farmslot gateway, nodes, recipes, runners, and
artifact packages.

This package is intentionally small at runtime: it exports protocol constants,
TypeScript types, and validation helpers. It does **not** execute recipes, talk
to browsers/devices, or contain project-specific actions.

## Canonical documents

The npm package is a consumable API surface. The source-of-truth architecture is
published on the Farmslot docs site:

- [Recipe Protocol v1](https://farmslot.io/docs/reference/recipe-protocol-v1) — canonical recipe schema, action vocabulary, graph rules, artifacts, and quality rules.
- [Recipe Runner Protocol](https://farmslot.io/docs/reference/recipe-runner-protocol) — runner-facing manifest and artifact guidance.
- [Recipe Composition Quality](https://farmslot.io/docs/reference/recipe-composition-quality) — how to keep recipes concise, reusable, and reviewable.

If this README conflicts with the public Recipe Protocol v1 reference, the protocol reference wins.

## Install

```bash
yarn add @farmslot/protocol
# or
npm install @farmslot/protocol
```

## Main exports

```ts
import {
  OFFICIAL_RECIPE_ACTIONS,
  RECIPE_PROTOCOL_SCHEMA_VERSION,
  getRecipeActionManifestActionNames,
  getRecipeWorkflowActions,
  validateArtifactManifestDocument,
  validateRecipeActionManifestDocument,
  validateRecipeArtifactPackage,
  validateRecipeDocument,
  validateRecipeWithManifest,
  type OfficialActionName,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';
```

## Public API map

| Import path                                        | Use for                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`                               | Root import for common recipe validators, constants, shared contracts, RPC names, and transport helpers. |
| `@farmslot/protocol/contracts`                     | Shared domain data contracts.                                                                            |
| `@farmslot/protocol/contracts/runs`                | Run, run-family, evidence, and publication contracts.                                                    |
| `@farmslot/protocol/contracts/slots`               | Slot and slot-adjacent contracts.                                                                        |
| `@farmslot/protocol/rpc`                           | Gateway RPC method registry and typed method maps.                                                       |
| `@farmslot/protocol/rpc/run`                       | Run RPC params/results and run method names.                                                             |
| `@farmslot/protocol/recipe`                        | Recipe Protocol v1 validation, action vocabulary, schema URL mapping, and manifest helpers.              |
| `@farmslot/protocol/schemas/recipe-v1.schema.json` | Published JSON Schema for Recipe Protocol v1.                                                            |
| `@farmslot/protocol/recipes/step-io`               | Runner recipe artifact reference contracts.                                                              |
| `@farmslot/protocol/surfaces/command-center`       | Command Center client surface registry used to build safe chat context.                                  |
| `@farmslot/protocol/transport/events`              | Gateway event contracts.                                                                                 |

Public subpaths are explicit and extensionless. There are no `types`, `methods`,
or `recipe-compat` package aliases.

Key responsibilities:

- define the stable Recipe Protocol v1 action vocabulary;
- publish the Recipe Protocol v1 JSON Schema at `https://farmslot.io/schemas/recipe-v1.schema.json` and `@farmslot/protocol/schemas/recipe-v1.schema.json`;
- validate recipe documents and workflow graph shape;
- validate action manifests declared by project runners;
- validate recipe usage against a manifest;
- validate runner artifact packages (`recipe.json`, `summary.json`, `trace.json`, `artifact-manifest.json`);
- share gateway/node/run family types used by Farmslot apps.

## Source layout

The protocol package is organized by contract ownership:

| Path                    | Owns                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | Package root export surface. Keep it stable and intentional.                                                   |
| `src/version.ts`        | Node↔Gateway protocol version.                                                                                 |
| `src/agents/*.ts`       | Agent role labels/window/ranking helpers shared by Gateway and clients.                                        |
| `src/contracts/*.ts`    | Domain data contracts for runs, slots, recipes, reviews, resources, backlog, chat, evals, etc.                 |
| `src/rpc/*.ts`          | Gateway RPC params/results and typed method-name maps.                                                         |
| `src/recipe/*.ts`       | Recipe Protocol v1 validation context, recipe graph validation, action manifests, and artifact packages.       |
| `src/recipes/*.ts`      | Worker/runner recipe IO and artifact reference contracts.                                                      |
| `src/surfaces/*.ts`     | Client surface registries used to derive safe chat/tool context.                                               |
| `src/integrations/*.ts` | External-system reference helpers such as canonical GitHub PR ref parsing/formatting.                          |
| `src/transport/*.ts`    | Gateway events, WebSocket frame shapes, binary relay markers, and worker signal contracts.                     |
| `src/runs/*.ts`         | Run-family analytics, readiness projection helpers, and run-specific behavior not owned by raw data contracts. |
| `src/workers/*.ts`      | Shared worker-control predicates such as tmux worker watchlist helpers.                                        |

Tests live under `test/`, mirroring the source ownership directories. Source files
should not contain colocated package tests.

## Export and versioning rules

- Public package imports are explicit in `package.json#exports`; do not add glob exports.
- Do not add `.js` package subpath aliases. Source-relative imports still use `.js` as required by NodeNext.
- Do not reintroduce `@farmslot/protocol/types`, `@farmslot/protocol/methods`, or `@farmslot/protocol/recipe-compat`.
- Add new fields as optional unless every caller is upgraded in the same PR.
- Bump `PROTOCOL_VERSION` in `src/version.ts` when node↔gateway methods, events, binary frames, or required payload fields change.
- Keep `package.json` `exports` aligned with any new public owner directory.
- Do not export service internals, UI-only state, or project-specific action implementations.

## Recipe validation

```ts
import { validateRecipeDocument } from '@farmslot/protocol';

const result = validateRecipeDocument(recipeJson);
if (result.status === 'invalid') {
  throw new Error(result.findings.map((finding) => finding.message).join('\n'));
}
```

`validateRecipeDocument` checks protocol-level structure. It does not prove that
a project runner can execute every action. Use `validateRecipeWithManifest` for
that.

## Action manifest validation

Every runner publishes a manifest describing what it can actually execute.
Official actions come from `OFFICIAL_RECIPE_ACTIONS`; project actions must be
namespaced, for example `example.trade.place_order` or `checkout.ensure_cart`.

```ts
import {
  validateRecipeActionManifestDocument,
  validateRecipeWithManifest,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

const manifest: RecipeActionManifestDocument = {
  runner_protocol_version: 1,
  action_registry_version: 1,
  supported_official_actions: ['command', 'wait', 'end'],
  custom_actions: [
    {
      name: 'example.echo',
      description: 'Echoes a message for adapter smoke tests.',
      schema: { type: 'object', required: ['message'] },
    },
  ],
};

const manifestResult = validateRecipeActionManifestDocument(manifest);
const recipeResult = validateRecipeWithManifest(recipeJson, manifest);
```

A valid manifest must stay honest: declare only actions the runner implements,
and keep custom actions durable enough to reuse across tasks.

## Artifact package validation

Recipe runs should emit a portable evidence package. Use protocol validation
before a gateway or reviewer trusts the result.

```ts
import { validateRecipeArtifactPackage } from '@farmslot/protocol';

const result = validateRecipeArtifactPackage({
  manifest: artifactManifestJson,
  artifactPaths: [
    'recipe.json',
    'recipe-resolution.json',
    'summary.json',
    'trace.json',
    'artifact-manifest.json',
  ],
  recipe: recipeJson,
  recipeResolution: recipeResolutionJson,
  resolvedRecipes: resolvedRecipeDocumentsByDigest,
});
```

## Maintenance rules

These rules keep the public contract small and stable:

1. **Protocol owns vocabulary, not project behavior.** Do not add wallet, Perps,
   checkout, or app-specific actions to the official action list.
2. **Parameterize before multiplying.** Prefer one configurable action or recipe over
   many near-duplicates.
3. **Fail closed.** Unknown actions, undeclared parameters, invalid artifact
   paths, and malformed manifests should produce validation errors, not warnings
   that execution ignores.
4. **No fabricated proof.** Protocol fields must support real user-visible proof;
   setup can prepare fixtures, but proof-phase recipes must not fake UI/app state.
5. **Artifacts must be portable.** Paths are relative, secrets are redacted, and
   summaries/traces must be useful outside the original machine.
6. **Docs and types move together.** Any field or rule change must update
   the public Recipe Protocol v1 reference, tests, and exported types in the same PR.
7. **Tests cover every domain contract.** Domain files need focused tests, and
   package quality must run the full `test/**/*.ts` set.
8. **Owner modules only.** Add logic to `src/contracts/*`, `src/rpc/*`, `src/recipe/*`, or focused helper owners, never to package-root exports.

## Change checklist

Before merging protocol changes:

1. Identify the owner module (`src/contracts/*`, `src/rpc/*`, `src/recipe/*`, or focused helper).
2. Update the owner contracts/helpers and mirrored `test/` coverage.
3. Update explicit package exports only when a new public owner module is introduced.
4. Update canonical docs when Recipe Protocol v1, runner artifacts, or public APIs change.
5. Run full protocol quality and any affected package/service quality.

## Local quality

From the Farmslot repository root:

```bash
yarn workspace @farmslot/protocol quality
# or, for protocol tests through Command Center wiring:
yarn test:protocol
```

Do not publish a protocol version unless these pass and the canonical docs match
the exported API.

## License

MIT. See [LICENSE](LICENSE).
