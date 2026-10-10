# Changelog

All notable changes to `@farmslot/docs` are tracked here.

## Unreleased

- Document sandbox runtime-home isolation and direct client targeting.

- Gateway onboarding documents URL-matched profile authentication and local sandbox routing.
- Document read-only node prerequisites before prepare and in slot.check.
- Recipe Protocol v1 reference: array indexing in templates (`[n]` or `.n`, a key on an object), and `workflow.invalid_template` for a template that does not parse.
- Gateway API reference: the generated reference shows protocol 0.35.0.
- Web adapter reference: every process that loads the `web-dapp` venue policy refuses imports resolved from the policy's digested files that land outside them (Node.js 22.15 or later).
- Web adapter reference: document `web-dapp` (`createWebDappAdapter`, the venue policy, the extension signer module and the hooks a host passes), and its locked-session refusal (`SESSION_LOCKED`).
- Adapter SDK reference: `CommandEventStream.stage(name, { index, total })`, the `StageHandle` a platform reports setup progress through (`StageProgress`), and `noopStage` for a stream without stages.
- Adapter SDK reference: the optional `readiness` member (`AdapterReadiness`), what `doctor`, `status` and `prepare` ask a platform; `extends` merges it member by member.
- Adapter SDK reference: `run`, `run --plan` and `call` refuse `--record-video` on an adapter without `recording` before recipe execution (`RECORDING_UNSUPPORTED`, exit 2); a run that still reaches the missing target fails with the same code, exit 4.
- Adapter SDK reference: `call` reads an inline `--record-video=<mode>` after the action as the option, like `run`, so it is refused on an adapter without `recording` too.
- Adapter SDK reference: the `environment` failure class (`ENVIRONMENT_NOT_READY`) in the classification order.
- Web adapter reference: `createExtensionNetworkObserver` takes an optional `extensionId`, the extension to capture.
- Web adapter reference: document `network-observer` and `performance-observer` (Extension network capture and CDP performance traces), `connectBrowserCdp` events and `selectExtensionTarget`.
- Agent runtime and task directory contract: `artifacts/acceptance-status.json` is written by `farmslot-agent ac` and by a recipe run with a task dir, through one module.
- Document adapter plugins declared in `recipe-library.json` `adapters`: loading on selection, the checks, `extends` composition, the trust rule (the exact operator library list, the plugin digest an approved plan binds, the files a plugin may import and the ones refused, the doctor check), and the Adapter SDK members `extends?`, `doctor?`, `actions.manifestPaths?` and `actions.adapters?`.
- Web adapter reference: document `dapp` (record or answer a dapp's wallet requests, assert the request log, product signing policy as input) and `origin`.
- Add the Node adapter reference (`@farmslot/adapter-node`: `createNodeAdapter`, `nodeDependencyBlock` with a host `resolveBin`, `workspaceTsconfigEnv` mapping each package to its `src`, `checkoutWorkspacePackages`, `scripts/cleanup.sh`).
- The Expo guide becomes the React Native adapter guide at `/docs/guides/adapter-rn` (`@farmslot/adapter-rn`, renamed from `@farmslot/expo-recipe`).

- Rename the recipe harness package pages to `@farmslot/recipe-runner` (`/docs/architecture/recipe-runner`).
- Add the Adapter SDK reference (`@farmslot/adapter-sdk`: `PlatformAdapter`, `defineAdapter`, the adapter registry), including the lifecycle members (`launch`, `detect`, `targets`, `flags`, `failurePatterns`, `devServer.portEnv`) and the detection and failure-classification rules.
- Document the Adapter SDK run members: `run` (`AdapterRun`, with the platform's own run options and browser record as type parameters), `recording.framed.activePidEnv`, `diagnostics.requestLog`, and the shared run types.
- Document the Adapter SDK `observation` member (`network.backend`, `network.actions`, `performance.start`) and the `RunObserver` and `NetworkCaptureBackend` types.
- Drop `devServer.portFlags` from the Adapter SDK reference (removed from the SDK).
- Add the `@farmslot/adapter-web` reference page.
- Web adapter reference: add `launch-browser` and `slot-title`, the launch sequence, and the `browser-resolver.cjs` command contract.

- Document which package-manager values leave the approved plan environment and the shared `run`/`validate` exit codes for malformed library entries.

- Add the Recipe discovery quickstart and reference (`farmslot-recipe actions/list/describe/explain`), and install `@farmslot/recipe-cli` wherever guides use the `farmslot-recipe` command.

- Document native run recovery and external adoption, absolute task paths, and the required CLI-before-gateway upgrade order.

- Document runner catalog and visible-model preference RPCs.

- Refresh the generated gateway API reference to protocol 0.33.0.

- Update the Command Center ready-gate capture fixture to show static independent review.

- Document how to try and monitor the three opt-in assessment suggestions.

- Publish the Action Manifest v1 schema with the official `ui.scroll_to` action, its required `surface_test_id`/`target_test_id` parameters, and string parameter pattern validation.
- Refresh the generated gateway API reference for the acceptance evidence assessment RPCs.

- Document structured-assessment provider selection and the distinction between provider support and evaluated consumer eligibility.

- Document opt-in failure and pending-decision advice, source approval and honest assessment monitoring.

- Separate experimental assessment monitoring from evaluation-gated workflow integrations; remove instructions to trigger inference through PR matching.

- Document assessment monitoring and evaluation endpoints.

- Refresh the generated gateway API reference for the structured assessment status/test RPCs.

- Document the gateway.update RPC for safe source checkout updates.

- Task directory contract page: a slot-free static review workspace mirrors `subtasks/` into its operator-visible view under the worker's own names, the review-workspace progress publisher and that view mirror are listed as consumers of the child-unit files, and the layout tree shows `acceptance-status.json` under `artifacts/`, where it is written.
- The agent-runtime and task-directory-contract reference pages document child checklist units as a worker surface, not just files: the `mark sub` verbs, the `--from` sources and the refused `template:<id>`, the ownership, settled and blocked rules, the acceptance-criteria ledger with `farmslot-agent ac`, and the live/stale projection. Child units are projected and mirrored for slot runs.
- Reference page for `@farmslot/capabilities` (node/gateway shared primitives), linked from the package README and the npm manifest.
- Gateway API reference regenerated for protocol 0.30.0 (child checklist unit and acceptance-ledger fields on task progress).
- Task directory contract documents `subtasks/`: the child checklist unit layout, its producers and consumers, that it travels to the slot as a directory and mirrors back per file, and that the `*.worker` mirror never travels outbound (ADR-060).
- Task directory reference: the acceptance-criteria ledger (`artifacts/acceptance-status.json`), its one writer (`farmslot-agent ac`), its consumers, and the `task.acceptanceCriteria` handoff field.

- Gateway API reference reports protocol `0.29.0`.

- Task directory and agent-runtime references: templates carry no run mode; `--run-mode` is optional and only matches project default rules.

- Document `{pi_path}` as a pool `dispatch_cmd` placeholder.

- Document the guarded terminal session-ending endpoint.

- Worker-prompt customization guide: the example task block no longer shows a `STATUS:` line and the sample checklist starts with `mark start`.

- Document static review publication and retry in the gateway API reference.

- Gateway API reference lists `run.rereviewLatestHead`.
- Gateway API reference lists the `pr.list.updated` event.
- Task directory contract and agent-runtime reference: the gateway no longer writes a default-valued `checklist-target.json`; absent means `CHECKLIST.md` + `SIGNAL.json`.
- Document native worker creation and node owner assignment commands.
- Regenerate the gateway API reference for protocol 0.26.0.
- Task directory contract: one producer (`task init`), `handoff.json` as the task record, optional `checklist-target.json`, `sandbox.json` readiness record; ledger rows shipped.
- Task directory contract and worker-artifacts pages: `pr-description.md` is the dev/fix-bug outcome on both Farmslot and skill runs.
- Add the task directory contract reference (TASK.md task document + CHECKLIST.md execution checklist, provenance and handoff files, what travels to the slot) and point the agent-runtime, worker-artifacts, and template-variables pages at it.
- Document native session commands, duplicate-safe session creation, and session-owned source and Git changes reads through the gateway.

- Document the gateway GitHub account inventory method.

- Document the gateway methods and events for PR monitoring, review rules, and push notifications.

- docs(api): regenerate the gateway API reference for `resource.device.inventory` and classify it read-only in the generator.
- Regenerate the Gateway API reference for protocol `0.24.0` — adding `run.sessionCommand`, `tmux.pasteText`, `runtime.posture.{preview,apply,status}`, and `runtime.capability.stopWarm` — and guard its freshness in CI so it cannot go stale again.
- Document the sustained-pressure admission, history-only pressure read, and gateway-owned pressure dispatch-gate methods (MANUAL-000109).
- Document the machine-scoped pause, release, status, and restore Gateway methods.
- Refresh the generated Gateway API reference with backlog refinement methods.
- Document that pool dispatch templates must expose a runner-path placeholder for runtime-owned arguments.
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
- The published `recipe-suite-result-v1` schema allows `evidence_incomplete` on a suite verdict (`reason: capture_interrupted`, `detail`, `evidence_path`).
