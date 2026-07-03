# Changelog

All notable changes to `@farmslot/handoff` are tracked here.

## Unreleased

- Scaffold `@farmslot/handoff` with the Learning Package Format v1 JSON Schemas shipped as package assets and matching TypeScript types.
- Add `validateLearningPackage(dir)`: validates a package directory against the format spec — required file set, per-file schema conformance including if/then co-constraints, and the run-slug grammar.
- Add the fail-closed scrubber: positive-identification secret detection (BIP-39 recovery phrases, private keys, tokens, JWTs), file-type allowlist with omit-by-default for unscannable inputs, and `scrub-report.json` generation.
- Add `assembleLearningPackage` for the fleet layout with a single blocked-return contract and local-only quarantine of blocked assemblies.
- Fix `scrubFiles` public API: `retainedText` and `retainedMedia` are now empty on `blocked` status so raw content is never returned from a blocked outcome.
- Simplify scrubber floor to a light heuristic backstop targeting accidental secret inclusion by a cooperative producing agent; remove over-engineered decode/normalization layers; document producer-instruction contract and human approval gate as the primary controls in README.
