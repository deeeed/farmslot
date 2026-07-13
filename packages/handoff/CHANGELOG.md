# Changelog

All notable changes to `@farmslot/handoff` are tracked here.

## Unreleased

- Add `taskKey` (cross-attempt task-family key) to `manifest.json` and the index-row schema, `deriveTaskKey` (normalized ticket, else content hash), automatic stamping during assembly (including quarantine manifests), and the `indexes/by-task/` family index. Additive per the spec changelog - no schemaVersion bump.
- Add `writeLearningPackage`: append-only git write of an assembled package plus one JSONL row per index dimension (engineer/project/domain/flow/ticket/task). A real write requires explicit per-call human approval (`consent.humanApproval: true` - manual approval forever, never sticky, never file-resolved); `dryRun: true` computes the would-write path and index rows with no destination IO. Rewrites of an existing package path are refused.
- Add the `resolve/` override engine: `resolveFile`/`resolveContent` walk `personal > domain > farm > default` first-match with full shadow recording and non-silent logging. Broken overrides warn and degrade to the shipped default (recorded in provenance), never throw - the binding unhappy-path contract.
- Add `task-io`: `extractTaskDocument` (allowlist-only normalization to `source.json`; zero-config for text/file/github sources; Jira strictly opt-in via caller field map - no Jira defaults ship) and `renderTaskMarkdown` (template resolution through the override chain with a shipped generic default template).
- Add `pr-publish`: `buildPrPackage` (pure/local PR body + evidence composition) and `publishPrEvidence` (explicit per-call consent guard enforced; dry-run upload plan; the remote transport is an honest v1 stub).
- Extend the scrub floor with cookie-header, OAuth-token, and session-token patterns; detect recovery phrases inside JSON-stringified blobs (literal `\n` separators); add UNION-only `extraDenyPatterns` (overrides can only add, never loosen) and `[REDACTED:<kind>:sha256:<12>]` in-file redaction of non-blocking secrets (emails, wallet addresses - the latter farm-configurable as public test addresses).
- Expand the adversarial scrub fixture suite (wallet fixtures, `.env` blobs, JSON-escaped SRPs, cookie/OAuth/session tokens, UNION-only assertions, redaction round-trips) and add write-IO, resolution, task-io, pr-publish, and task-key suites, including a compile-time test that a blocked `AssembleResult` cannot reach `writeLearningPackage`.
- Scaffold `@farmslot/handoff` with the Learning Package Format v1 JSON Schemas shipped as package assets and matching TypeScript types.
- Add `validateLearningPackage(dir)`: validates a package directory against the format spec — required file set, per-file schema conformance including if/then co-constraints, and the run-slug grammar.
- Add the fail-closed scrubber: positive-identification secret detection (BIP-39 recovery phrases, private keys, tokens, JWTs), file-type allowlist with omit-by-default for unscannable inputs, and `scrub-report.json` generation.
- Add `assembleLearningPackage` for the fleet layout with a single blocked-return contract and local-only quarantine of blocked assemblies.
- Fix `scrubFiles` public API: `retainedText` and `retainedMedia` are now empty on `blocked` status so raw content is never returned from a blocked outcome.
- Simplify scrubber floor to a light heuristic backstop targeting accidental secret inclusion by a cooperative producing agent; remove over-engineered decode/normalization layers; document producer-instruction contract and human approval gate as the primary controls in README.
