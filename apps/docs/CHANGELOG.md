# Changelog

All notable changes to `@farmslot/docs` are tracked here.

## Unreleased

- Publish the Action Manifest v1 schema and concise runtime contract.
- Document direct learning destination overrides.
- Document zero-config local learning staging and explicit per-farm sharing configuration.
- Document secure, approval-gated sharing of portable run learnings.
- Add editor help to every field in the hosted Recipe v1 JSON Schema.
- Document parameterized, composable Recipe v1 authoring, discovery, execution, and the removal of the separate flow surface.
- docs: worker-template-quality, worker-artifacts-by-flow, and worker-run-finish state the reviewer-flow exception — self-review/self-review-fix require their feedback/report artifact instead of `learnings.md`, and self-review no-change requires `review-feedback.md`.

- docs: the human-ready-gate demo capture (fixture label, verification list, prose, recipe assertion) uses the unified _Independent Review_ language (MANUAL-000008); the checked-in demo screenshot refreshes on the next capture-harness run.

- docs: rename the branch-maintenance flow `merge-main` → `update-branch` across the worker-artifacts/finish/quality reference pages, the customize-worker-prompts guide, and generated template-variable docs.
- Document passive UI observations in Recipe Protocol v1 and refresh the published recipe schema.
- Regenerate the gateway API reference to drop the removed `slot.prepare.output` event.
- Publish the canonical Recipe Protocol v1 JSON Schema at `/schemas/recipe-v1.schema.json`.
- Document `checklist-target.json` manifest routing for `./mark` and nested-loop signal derivation in the worker signal protocol reference.
- Document Recipe Protocol v1 closeout: manifest-first artifacts, agent-runtime recipe-quality ownership, and worker artifact guidance.
- Document the `artifact_available` prepare requirement and ref threading in the prepare-lifecycle reference.
- Document `@farmslot/agent-runtime` as the canonical worker finish/runtime helper layer and update recipe-quality contract references.
- Add a Domains reference guide and update worker-prompt customization docs for the team→domain rename.
- Active-development baseline; add user-facing changes here before release or package publication.
