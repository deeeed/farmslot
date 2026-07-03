# @farmslot/handoff

Reference implementation of the **Learning Package Format v1** — the self-contained,
project-agnostic package one completed agent run hands off for later mining.

The format itself is defined by JSON Schemas shipped as package assets under
`schemas/`. Those schemas, not this code, are the authority: any producer whose
output validates against them is conformant, with or without a farmslot
dependency. This package provides the matching TypeScript types, the reference
validator, the fail-closed scrubber, and the fleet-layout assembler.

Nothing here is tool-chain-specific. There are no Jira, GitHub, or wallet nouns in
the package or its defaults — every such specific is caller-supplied config or a
resolved override file.

## Install

```bash
yarn add @farmslot/handoff
```

## Source layout

| Path                               | Owns                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `schemas/*.schema.json`            | The normative format spec: the seven required-JSON-file schemas (Draft 2020-12). Shipped as assets. |
| `src/spec/version.ts`              | Format markers (`SCHEMA_VERSION`), the required-file set, and the run-slug grammar.                 |
| `src/spec/types.ts`                | TypeScript types conforming to the shipped schemas.                                                 |
| `src/spec/schemas.ts`              | Runtime loader for the shipped schema assets.                                                       |
| `src/validate/json-schema.ts`      | Bounded JSON-Schema validator engine (the keyword subset the format uses, including `if`/`then`).   |
| `src/validate/validate-package.ts` | `validateLearningPackage(dir)` — the section 8 reference validator.                                 |
| `src/validate/run-slug.ts`         | Run-slug grammar check.                                                                             |
| `src/scrub/floor.ts`               | The positive-identification crypto-secret floor (recovery phrases, keys, tokens).                   |
| `src/scrub/scrubber.ts`            | The fail-closed five-layer scrub gate and `scrub-report.json` generation.                           |
| `src/scrub/data/`                  | Reference data for detection (the standard BIP-39 English wordlist).                                |
| `src/learning-package/`            | `assembleLearningPackage` (fleet layout) and its input/result contracts.                            |

Tests live under `test/`, mirroring the source directories. The adversarial scrub
fixture suite lives in `test/scrubber.test.ts` + `test/fixtures/`.

## Public API map

| Export                          | Purpose                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `validateLearningPackage`       | Validate a package directory against the format spec.                          |
| `assembleLearningPackage`       | Assemble one package from a completed fleet run, with the blocked-return gate. |
| `scrubFiles`                    | Run the fail-closed scrub gate over candidate files.                           |
| `scanForFloorSecrets`           | Positive-identification secret scan of a text string.                          |
| `loadSchema` / `loadAllSchemas` | Load the shipped spec schema assets.                                           |
| `isValidRunSlug`                | Check the run-slug grammar.                                                    |

Subpath exports: `@farmslot/handoff/spec`, `/validate`, `/scrub`,
`/learning-package`, and the raw assets at `/schemas/<name>.schema.json`.

## Maintenance rules

1. **The spec is the authority.** `schemas/` defines validity; the validator is
   downstream. A schema change is a spec change — bump `SCHEMA_VERSION` for any
   breaking change and update readers, never repurpose a field.
2. **Fail closed.** The scrub floor blocks on positive identification and omits
   the unscannable; it is never loosened. Overrides may only add patterns (union).
3. **Closed core, open extensions.** New structured fields go in an `extensions`
   object, never as new closed-core keys without a `SCHEMA_VERSION` bump.
4. **No tool-chain specifics.** Keep Jira/GitHub/wallet vocabulary out of the
   package and its defaults; those are caller config or resolved override files.
5. **The scrubber's fixture suite is a gate.** Any change to the floor must keep
   every adversarial fixture blocked-or-omitted and every clean fixture passing.
6. **No raw secrets in reports.** Scrub records carry `kind` + fingerprint only.

## Local quality

From the Farmslot repository root:

```bash
yarn workspace @farmslot/handoff quality
```

This runs format check, lint, typecheck, build, and the full test suite —
including the adversarial scrub fixture suite.

## License

MIT
