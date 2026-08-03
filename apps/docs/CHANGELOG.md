# Changelog

All notable changes to `@farmslot/docs` are tracked here.

## Unreleased

- Publish Recipe v1 visual-review hierarchy, navigation, and related-surface metadata in the hosted schema.
- Publish the opt-in `ui.capture_surface` Action Manifest schema for full-page and full-scroll-surface evidence.
- Document canonical adapter-first recipe library directories and temporary legacy suffix compatibility.
- Publish typed continuous-gesture actions and manifest-owned adapter-specific parameter validation in the hosted Recipe v1 schemas and runner reference.
- Remove the unregistered `farmslot api list`/`describe` commands and every claim that the gateway serves a `protocol.capabilities` discovery method, across the gateway-api-protocol, gateway-api, local-demo-and-cli, and roadmap pages, in favour of the real `farmslot rpc` escape hatch and the build-time capability snapshot.
- Correct the worker reference pages against the worker terminal contract: dev/fix-bug complete on `pr-description.md`, review-pr always requires `line-comments.json`, and the standalone finish example uses the real `farmslot-agent install-mark` plus `--checklist` bootstrap.
- Publish the `@farmslot/agent-runtime` reference the published package README links to, documenting the task-directory form of `mark` and the `checklist-target.json` requirement.
- Document the explicit Metro bridge port contract for Expo recipe consumers.
- Regenerate the Gateway API reference for protocol `0.15.0`.
- docs: document reconciled recipe failure causes and standalone suite evidence contracts.
- Document the authenticated `gateway.ping` liveness method as read-only and regenerate the Gateway API reference.
- Document shared execution-template sources, selection, and domain configuration.
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
