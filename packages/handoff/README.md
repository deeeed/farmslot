# @farmslot/handoff

Reference implementation of the **Learning Package Format v1** — the self-contained,
project-agnostic package one completed agent run hands off for later mining.
Guide: <https://farmslot.io/docs/guides/learning-package>.

The format itself is defined by JSON Schemas shipped as package assets under
`schemas/`. Those schemas, not this code, are the authority: any producer whose
output validates against them is conformant, with or without a farmslot
dependency. This package provides the matching TypeScript types, the reference
validator, the fail-closed scrubber, the assemble/write pair, the one
override-resolution engine, and the task-io/pr-publish boundary helpers.

The package is tool-chain-agnostic: no Jira, GitHub, or wallet vocabulary appears
in the harness defaults or assembler logic. Tool-chain specifics that legitimately
belong in the format (for example, `sourceKind: "jira"` or `"github-pr"` fields
defined by the spec schemas) are spec-defined nouns, not implementation choices —
everything else is caller-supplied config or a resolved override file.

## Secret-handling contract

The scrubber is a **light heuristic backstop**, not a completeness guarantee.
It catches obvious accidental inclusions by a cooperative producing agent: literal
seed phrases, labeled private-key assignments, PEM blocks, known provider tokens.
Note the floor matches hex keys only when LABELED (`privateKey:`, `PRIVATE_KEY=`,
...): a bare unlabeled 64-hex string is deliberately not matched, so integrity
hashes and tx ids never false-block - an unlabeled raw key is handled by the
producer instruction and the human gate, not the regex.

**The two real controls are:**

1. **Producer-instruction contract** — the closeout/finish prompt MUST tell the
   producing agent: "never include raw secrets, seed phrases, private keys,
   passwords, or tokens; reference them by name only." That is the primary control.
2. **Human approval gate** — every package write requires an explicit human
   approval argument at call time (no auto-write mode). That is the reliability
   guarantee.

The scrubber reduces surface area between those two controls. It does not attempt
to defeat adversarial obfuscation.

Deliberate detection choices and known limits:

- Recovery-phrase detection blocks ANY run of 12+ consecutive wordlist words,
  not only exact mnemonic lengths — a fail-closed trade (wallet dumps carry
  adjacent wordlist words; 12+ in genuine prose is practically nonexistent).
- Structured cookie-jar detection matches the common `{"name":...,"value":...}`
  adjacent-ordered shape; reordered or intervening-field variants are a known,
  accepted limit of the heuristic backstop.
- JSON-escape handling covers up to double-stringified content; deeper nesting,
  non-JSON serializations, and homoglyph tricks are out of the cooperative
  model's scope.
- DETECTION of secrets composed across separate object values/fields (e.g. six
  mnemonic words in one field, six in another) is scope-capped; the QUARANTINE
  audit trail, however, is serialization-scanned and wholesale-redacted so a
  blocked package's audit files never carry such a composition raw.

## Install

```bash
yarn add @farmslot/handoff
```

## Source layout

| Path                               | Owns                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `schemas/*.schema.json`            | The normative format spec: the eight spec JSON-file schemas (Draft 2020-12). Shipped as assets.        |
| `src/spec/version.ts`              | Format markers (`SCHEMA_VERSION`), the required-file set, and the run-slug grammar.                    |
| `src/spec/types.ts`                | TypeScript types conforming to the shipped schemas.                                                    |
| `src/spec/schemas.ts`              | Runtime loader for the shipped schema assets.                                                          |
| `src/validate/json-schema.ts`      | Bounded JSON-Schema validator engine (the keyword subset the format uses, including `if`/`then`).      |
| `src/validate/validate-package.ts` | `validateLearningPackage(dir)` — the section 8 reference validator.                                    |
| `src/validate/run-slug.ts`         | Run-slug grammar check.                                                                                |
| `src/scrub/floor.ts`               | The positive-identification crypto-secret floor (recovery phrases, keys, tokens).                      |
| `src/scrub/scrubber.ts`            | The fail-closed five-layer scrub gate and `scrub-report.json` generation.                              |
| `src/scrub/data/`                  | Reference data for detection (the standard BIP-39 English wordlist).                                   |
| `src/learning-package/`            | `assembleLearningPackage` + `writeLearningPackage` and their input/result contracts.                   |
| `src/resolve/`                     | The one override engine: `personal > domain > farm > default` first-match + shadow logging.            |
| `src/task-io/`                     | Source normalization (`extractTaskDocument`) and task-doc rendering (`renderTaskMarkdown`).            |
| `src/pr-publish/`                  | PR body/evidence composition (`buildPrPackage`) and the consent-guarded publish entry point.           |
| `src/spec/task-key.ts`             | `deriveTaskKey` — the cross-attempt task-family key (ticket-normalized or content-hashed).             |
| `templates/task-default.md`        | The shipped default task template (the `default` tier of the resolution chain).                        |
| `schemas/grade.schema.json`        | Optional `grade.json` (human verdict, copied verbatim post-scrub); `hasGrade`/`gradeSemantic` in rows. |

Tests live under `test/`, mirroring the source directories. The adversarial scrub
fixture suite lives in `test/scrubber.test.ts`, `test/scrubber-adversarial.test.ts`,
and `test/fixtures/`.

## Public API map

| Export                           | Purpose                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `validateLearningPackage`        | Validate a package directory against the format spec.                           |
| `assembleLearningPackage`        | Assemble one package from a completed run, with the blocked-return gate.        |
| `writeLearningPackage`           | Append-only git write + index rows; per-call human approval required; `dryRun`. |
| `deriveTaskKey`                  | Derive the cross-attempt task-family key (never coordinator-assigned).          |
| `resolveFile` / `resolveContent` | First-match override resolution with shadow logging; broken overrides degrade.  |
| `extractTaskDocument`            | Normalize a raw task source to `source.json` (allowlist-only PII floor).        |
| `renderTaskMarkdown`             | Render the task doc from the resolved template chain.                           |
| `buildPrPackage`                 | Compose PR description + evidence block (pure/local, writes nothing).           |
| `publishPrEvidence`              | Consent-guarded publish; `dryRun` upload plan (transport stubbed in v1).        |
| `scrubFiles`                     | Run the fail-closed scrub gate over candidate files (UNION-only extension).     |
| `scanForFloorSecrets`            | Positive-identification secret scan of a text string.                           |
| `loadSchema` / `loadAllSchemas`  | Load the shipped spec schema assets.                                            |
| `isValidRunSlug`                 | Check the run-slug grammar.                                                     |

Subpath exports: `@farmslot/handoff/spec`, `/validate`, `/scrub`,
`/learning-package`, `/resolve`, `/task-io`, `/pr-publish`, and the raw assets at
`/schemas/<name>.schema.json`.

## Unhappy-path contract (binding)

Closeout packaging is post-run and best-effort: _fail-closed on the share
decision, fail-open on the run._

- Missing override file → the resolution chain falls through to the shipped default.
- Broken override file → warn, record the fallback in `provenance.json`, use the
  default. Never a throw.
- Override boundary: an EXPLICITLY configured path (e.g. `templateRef`) that
  points at a missing file is a broken override and warns; a merely absent
  TIER file (personal/domain/farm location without the file) falls through
  silently by design.
- Scrub floor hit → the assembly is `blocked`: local quarantine (manifest +
  scrub-report only, no raw artifacts) and no repo write, ever.
- No approver present → assemble + `dryRun`; simply don't write. Not an error.
- `writeLearningPackage` refusals (invalid package, missing approval, append-only
  violation) throw with `Next:` guidance; callers treat them as warn-and-skip,
  never as a run failure.

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
