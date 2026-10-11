# ADR-062: Recorded run evidence

**Status:** Proposed
**Date:** 2026-10-11
**Owner:** Farmslot maintainers
**Scope:** Recipe execution, claim evidence, review gates, and public CLI/SDK
**Related:** [ADR-012](012-device-screen-streaming.md), [ADR-034](034-recipe-protocol-v1.md), [ADR-060](060-sub-task-observability.md), [Recorded run evidence specification](../reference/recorded-run-evidence.md)

## Context

Recipe authors should describe actions and verifiable expectations. Farmslot
should retain the evidence and let an engineer review each acceptance criterion
or QA check without managing recording or searching a long video.

The existing capture, timeline, ledger, lease and viewer pieces do not yet form
one feature. Parallel lifecycles, successful actions mistaken for proof, lost
artifact identity and separate client mappings prevent dependable review. This
ADR sets the architecture; its reference spec defines the proposed requirements.
Neither document claims the complete feature is shipped.

## Decision

### Hard design principles

- **P1 Transparent to the agent.** Execution automatically produces recording, markers, padded clips, stills, HUD captions and evidence links. Authors write no recording, timestamp or linking code.
- **P2 Automatic claim evidence.** Nodes declare which claims they prove through eligible expectations. The engine derives verdicts and moments; manual `ac set` is only an audited untestable override after cutover.
- **P3 Cheap by default.** UI recording is on with bounded CPU, disk, time and transfer cost. Virtual clips are immediate; separate encoded clips are produced only on demand.
- **P4 Harness-level integration.** One RecipeEngine and provider contract own lifecycle and evidence. Custom harnesses inherit this behavior without recording implementations.
- **P5 Weak-model proof.** A basic recipe author gets a complete review package from ordinary assertions without extra evidence instructions. Action-only false claims fail closed.
- **P6 Gate-first review.** Engineers review claim by claim through stills and one-action bounded playback, with checked expectations visible beside each claim.
- **P7 Public surface.** Every capability has a supported entry through the single recipe CLI and public SDK, with a named consumer and versioned contract.
- **P8 QA flows.** ACs, QA cases and QA checks use one claim model, one verdict reducer and one player model, including long composed and segmented recordings.

### Concepts and one owner per fact

An execution is one attempt. A claim is an AC, QA case or QA check. A marker
identifies one qualified node occurrence; a moment links a claim to that marker.
A clip is a view of the measured range, optionally encoded. A gate package is
the immutable selected evidence for review and authorized publication.

The trace owns intent, `proves` and assertion results. The recorder owns source
bytes and capture lifecycle facts. The timeline owns clock mapping and ranges;
marker labels are checked projections of the trace. The artifact manifest owns
file identity. One ledger writer owns claim verdicts and moment references. The
evidence manifest owns publication selection only. Storage owns retention; the
gateway owns resource admission. Digests used as references are checked, not
independent copies of facts. Neither a successful screenshot nor a HUD caption
is an executed expectation or a human visual judgment.

### Lifecycle and evidence

One engine plans the target, obtains backend-specific claims, starts capture,
executes actions/assertions, renders the final HUD, finalizes media, derives
claims/stills and freezes the package. Abort releases only owned resources and
retains usable partial evidence with its limitation. The specification's single
measured-range/padding rule governs seeking; it adds no precision contract or
clock-qualification system.

Claim registration extends recipe `proofTargets`. Qualified composition paths,
iteration identity and the last result of a declared retry determine occurrences;
required skipped checks remain missing. Visual claims wait for visual review,
while state assertions can establish state proof. QA parent cases aggregate the
same child verdicts, not a second QA evidence pipeline.

### One shared evidence review model

`createEvidenceReviewModel` in `@farmslot/adapter-sdk/evidence` owns claim-to-moment,
clip/still/marker traversal, caption, selection and seek state. Command Center PR
preview, Run Detail and lightbox, and Companion gate review and ArtifactViewer
consume it. Context changes presentation only. Each platform reuses its renderer;
no copied selectors, mappings or player view-models remain.

Both output-review gates show the retained report identity and QA case/check
results. Reviewing a report snapshot does not itself authorize publication or
release. Inactive clips load no media; selected clips use authenticated seeking.

### Existing pieces assessed

| Piece                                | Decision | Reason                                                                                                                         |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Timeline and markers                 | CHANGE   | Keep measured ranges/digests; validate labels as projections and connect ordered recording segments without invented coverage. |
| Recording lease registry             | KEEP     | Scoped ownership is sound; use backend/target conflict keys and identical SDK/hosted admission.                                |
| Native capture and timing backends   | CHANGE   | Preserve measured capture, sampling and interruption behavior; complete missing timing and segment results.                    |
| CDP recorder                         | CHANGE   | Bound encoding/spooling instead of retaining every PNG until stop.                                                             |
| Parallel runner/CLI framed lifecycle | REPLACE  | One engine must own start, snapshots, final HUD, cancellation and stop.                                                        |
| Artifact and evidence manifests      | CHANGE   | Immutable files/dependencies and publication selection need separate authority; remove duplicate claim `covers`.               |
| AC ledger/reducer                    | REPLACE  | One claim writer must use executed assertions, explicit aggregation and visual-review state, not action success.               |
| HUD                                  | CHANGE   | Keep the renderer and trace intent; order final outcome before capture stop.                                                   |
| Command Center lightbox              | CHANGE   | Keep validated seeking and controls; use the shared claim model and padded bounded playback.                                   |
| Companion viewer                     | CHANGE   | Keep native rendering; initialize only selected media and adopt the same model.                                                |
| Publication/refresh                  | CHANGE   | Select approved immutable bytes/dependencies and refuse substitution or unapproved selection.                                  |

### Public surface

The spec defines signatures, packages, consumers and release status. Commands
stay under `farmslot recipe run`, `artifacts`, `status`, and existing conformance
commands; there is no parallel command family. Serialized evidence belongs in
`@farmslot/protocol`; executable provider/engine contracts belong in the SDK.

Evolve `AdapterRecording` and the published `createDefaultRecipeEngine` factory,
not a second engine. Its current `@farmslot/recipe-cli/harness` export is public.
Move only the replaced engine exports in a coordinated breaking release; do not
ban that entire published subpath. A harness supplies target/action bindings and
inherits capture, derivation, cleanup and review data. Delete external recorder
wrappers, private timestamp math, manual normal verdicts and duplicate mappings.
Unrelated domain log/performance assertions remain outside this feature.

Generate CLI reference entries from the single definitions and ship the SDK
contracts, concepts and declarative-adoption guidance with implementation.

## Alternatives considered

1. **One source recording and virtual clips.** Reject ahead-of-time encoding per claim because it multiplies work and bytes.
2. **Measured ranges with fixed padding.** Reject guessed offsets and new precision machinery; unmeasured moments remain untimed.
3. **Executed assertions and explicit review.** Reject action/screenshot success as semantic proof, including when a weak author tags it with `proves`.
4. **One engine and portable review model.** Reject lifecycle/template copies and a new cross-platform player framework; only platform rendering differs.
5. **Frozen publication identity.** Reject rescanning mutable files as authority for approved refresh; reviewed bytes must remain reviewed bytes.

## Consequences

- Authors describe expectations; reviewers see what was actually checked.
- Every client navigates the same claim and recording identity.
- Bounded capture/encoding and lazy transfer require implementation changes and performance qualification; budgets are targets, not current measurements.
- Versioned claim/segment contracts require a clean migration.
- Untimed/outside/partial evidence stays visible without becoming false seekable proof.

## Migration

1. Complete shared engine derivation, assertion/segment contracts and public APIs through the existing canonical work. Pass conformance before changing normal verdict ownership.
2. Adopt the shared model and immutable package selection in clients/publication. Migrate verified legacy relationships once; retain other historical media as explicitly untimed.
3. Cut over each adopter with its own coordinated change linking this ADR. Until engine derivation passes, existing manual verdict steps remain the sole normal path. Then remove those steps in one cutover: never run two normal paths or writers. Delete replaced recorders, orchestration, link plumbing and imports; no shims.

Specific repositories, files and rollout coordination belong in separate adoption
records, not these public framework documents.
