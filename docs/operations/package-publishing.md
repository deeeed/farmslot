# Farmslot package publishing

Status: guarded publish-readiness. The package READMEs and public docs links are
ready for review, but the packages remain private until final publish approval. License metadata is MIT.

## Packages

| Package                    | Purpose                                                             | Public docs                                             |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `@farmslot/protocol`       | Recipe/gateway/node protocol types and validators.                  | <https://farmslot.io/docs/reference/recipe-protocol-v1> |
| `@farmslot/recipe-harness` | Reusable Recipe Protocol v1 runner, adapters, and artifact writers. | <https://farmslot.io/docs/architecture/recipe-harness>  |
| `@farmslot/expo-recipe`    | Expo/React Native recipe scaffold and validation helper.            | <https://farmslot.io/docs/guides/expo-recipe>           |
| `@farmslot/skills`         | Recipe-first adoption skills, CLI installer, and cooking utilities. | `packages/skills/README.md`                             |

## Token

Publishing uses an environment variable only:

```bash
export NPM_FARMSLOT_TOKEN=...
```

`.yarnrc.yml` references `${NPM_FARMSLOT_TOKEN:-}`. Never commit token values.

## Current safe checks

```bash
yarn packages:publish:check
```

This command verifies package metadata, public docs links, npm scope config, and
clean builds, built import contracts, and `yarn pack --dry-run` contents. It is safe while packages are still private.

## Strict publish gate

```bash
yarn packages:publish:check:strict
```

Strict mode is expected to fail until the final public-publish decision is made.
Before strict mode can pass, each package must have:

1. `private` removed or set to `false`;
2. `publishConfig.access: "public"`;
3. MIT license metadata and matching package/repository `LICENSE` files;
4. public docs deployed at `https://farmslot.io`;
5. a live public GitHub repository matching the package `repository.url`
   metadata, or an intentional metadata/checker update before strict mode is
   treated as release approval.

## Release cut before publish

Cut an `npm` release group and finalize changelogs before publishing:

```bash
yarn release:status
yarn release:cut --group npm --assist
yarn release:cut --group npm --from-proposal .release-cut/proposal.json --execute
```

See [release-process.md](release-process.md) for the full workflow and What's New surfaces.

Publish Recipe Protocol packages in dependency order:

1. `@farmslot/protocol`
2. `@farmslot/recipe-harness`
3. `@farmslot/expo-recipe`

## Publish command

There is intentionally no root publish command yet. Add one only after strict
mode passes, package export strategy is finalized, and a human explicitly
approves the first public release. Until then the repository exposes readiness
checks only.

## Build/export strategy

The packages now publish from `dist/` rather than TypeScript source.
`@farmslot/protocol`, `@farmslot/recipe-harness`, and `@farmslot/skills` build
JavaScript and declaration files before pack, and
`scripts/quality/check-farmslot-package-readiness.mjs` verifies required packed
files plus built import contracts. The
`@farmslot/recipe-harness` CLI bin imports `../dist/cli.js`, so local workspace
CLI smoke testing requires `yarn workspace @farmslot/recipe-harness build` first.
