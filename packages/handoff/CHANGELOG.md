# Changelog

All notable changes to `@farmslot/handoff` are tracked here.

## Unreleased

- Scaffold `@farmslot/handoff` with the Learning Package Format v1 JSON Schemas shipped as package assets and matching TypeScript types.
- Add `validateLearningPackage(dir)`: validates a package directory against the format spec — required file set, per-file schema conformance including if/then co-constraints, and the run-slug grammar.
- Add the fail-closed scrubber: positive-identification secret detection (BIP-39 recovery phrases, private keys, tokens, JWTs), file-type allowlist with omit-by-default for unscannable inputs, and `scrub-report.json` generation.
- Add `assembleLearningPackage` for the fleet layout with a single blocked-return contract and local-only quarantine of blocked assemblies.
