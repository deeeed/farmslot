# ADR-062: Recorded run evidence

**Status:** Proposed
**Date:** 2026-10-11
**Owner:** Farmslot maintainers
**Scope:** Recipe execution, recorded evidence, acceptance criteria, publish gates, and public SDK/CLI
**Related:** [ADR-012](012-device-screen-streaming.md), [ADR-034](034-recipe-protocol-v1.md), [ADR-060](060-sub-task-observability.md), [Recorded run evidence specification](../reference/recorded-run-evidence.md)

## Context

A recipe should leave an engineer with verifiable evidence for each acceptance
criterion, without asking its author to manage recorders, timestamps, clips or
publication links. The same feature must work through the recipe CLI, custom
harnesses, Command Center and Companion.

Capture, measured timelines, resource leases, AC ledgers and viewers exist, but
their ownership is fragmented. An MP4 can survive without its timeline; a valid
timeline can fail when an index supplies another video's digest. Farm templates
duplicate lifecycle mechanics, and native viewers do not receive marker identity.

This ADR defines the architecture. The linked normative spec defines contracts
and conformance. Both are proposals, not claims that the complete feature ships.
Private run inventories belong outside these public documents.

## Decision

### Hard design principles

- **P1 Transparent to the agent.** Recipe execution automatically produces capture, clip boundaries, timeline markers, HUD captions and evidence links. Authors write no recording, timestamp or linking code.
- **P2 Automatic AC evidence.** Nodes declare the AC IDs they prove. The runner derives verdicts, ranges, clips and stills from results. Manual `ac set` is an explicit untestable-case override, not the normal path.
- **P3 Cheap by default.** UI recipes always record within the specification's CPU, disk and time budgets. Encoded per-AC clips are materialized on demand, not during every run.
- **P4 Harness-level integration.** One Farmslot RecipeEngine owns this behavior through ProjectRuntime. Custom harnesses provide targets/actions and inherit evidence generation, with no recording implementation of their own.
- **P5 Weak-model proof.** A basic recipe-writing worker gets a complete gate package from a plain recipe without extra evidence instructions. Recording and verdict checklist steps disappear.
- **P6 Gate-first review.** Each publish gate presents ACs with verdicts, stills and immediate bounded-clip playback in Command Center and Companion.
- **P7 Public surface.** Every capability has a supported Farmslot CLI and SDK entry point. Consumers never import implementation files or create a parallel recipe command family.

### Concepts, ownership and invariants

A **recipe execution** is one immutable attempt. A **claim** is an AC, QA case or
QA check declared by the recipe. A **recording** is captured media; long executions
may have bounded segments. A **marker** ties one trace occurrence to measured
media-clock bounds. An **evidence moment** links a claim to that marker. A **clip**
is a bounded view, optionally materialized as a file. A **gate package** freezes
the selected evidence for review and authorized publication.

The RecipeEngine owns execution and capture lifecycle; its trace owns node
outcomes and intent. The recorder backend owns captured bytes and source-clock
measurements. The timeline owns their validated mapping. The acceptance writer
owns derived AC verdicts and moment references. Artifact storage owns immutable
bytes, availability and retention. The gateway owns resource leases and gate
selection, not another recording implementation. Clients own presentation.

References are scoped to an execution and trace occurrence. Cached labels and
ranges are projections, never independent authority. No consumer may seek with
a mismatched video/trace digest, infer media time from nominal FPS, turn missing
footage into proof, or alter reviewed bytes during refresh. The HUD and captions
use the same traced recipe intent. Capture failure is an evidence/environment
failure, not evidence of a product regression.

### Lifecycle and extension points

Resolve the target and recording policy during planning. Execution acquires its
claims and starts one recorder before the first UI proof node. Record node/HUD
events automatically. Paint the terminal HUD while capture is active, finalize
media, validate the timeline, derive AC moments/stills, then freeze the package.
Interruption preserves valid partial footage with incomplete evidence status;
abort always cleans up owned processes and leases.

ProjectRuntime declares target resolution, capabilities and resource claims.
Platform backends implement the shared recorder contract once. Harnesses compose
runtime, actions and domain libraries through the public engine. A new project
does not add recorder subprocesses, timestamp math or an evidence writer.

### Existing pieces assessed

| Piece                                 | Decision | Reason                                                                                                                                            |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline document and markers         | KEEP     | Measured clock ranges, digests and trace indices provide portable identity and honest uncertainty; scalar duplicated offsets would weaken them.   |
| Recording lease                       | CHANGE   | Retain scoped ownership, but derive claims from the selected backend/target instead of reserving a fleet-wide helper for every kind of capture.   |
| capture-helper and platform recorders | KEEP     | Native capture and source-clock measurement are platform concerns; fill timing gaps through the same backend contract.                            |
| Split runner/CLI framed lifecycle     | REPLACE  | One engine must own capture, snapshots, cancellation and finalization; parallel orchestration creates gaps and conflicting ownership.             |
| Evidence manifest                     | CHANGE   | Keep publication selection, but reference a complete immutable recording package instead of an unrelated copied MP4.                              |
| AC ledger                             | CHANGE   | Preserve one writer and verdict semantics; add typed moment references, derive normal verdicts, and restrict manual override to untestable cases. |
| HUD                                   | CHANGE   | Keep the intent/progress renderer; acknowledge capture boundaries and show terminal outcome before stopping the recorder.                         |
| Command Center lightbox               | CHANGE   | Its verified seeking is sound; supply automatic AC selection, bounded clips and complete package identity.                                        |
| Companion viewer                      | CHANGE   | Keep native rendering; use the same public validation/seek model and AC moments as Command Center.                                                |
| PR publication and evidence refresh   | CHANGE   | Preserve approval and race checks; generate moment links/clips from the frozen package and maintain dependency identity.                          |

### One shared evidence review model

`createEvidenceReviewModel` in `@farmslot/adapter-sdk/evidence` owns claim-to-clip,
still and marker traversal, identity checks, HUD captions, seek ranges and selected
moment state. Command Center PR preview, Run Detail and lightbox, and Companion
gate review and ArtifactViewer all consume it. Context selects presentation needs,
not another derivation. Only Lit/React Native rendering and media controls differ.
No duplicated selector, mapper, player view-model or evidence component remains.

### QA output review

Long composed QA uses the same claim, verdict and moment model. Nodes declare QA
case/check IDs in `proves`, with check-to-case parent relationships; no parallel
QA evidence pipeline is introduced. Both output-review gates show the retained
report snapshot and cases with pass/fail, stills and one-action clip playback.
Acknowledging `engine_output_review` means reviewing that snapshot, not release
or publication approval. Size-bounded recording segments and indexed markers
keep seek cost independent of total suite length; cross-segment moments retain
explicit continuity/gap information. Conformance includes 10+ cases and a check
spanning a segment boundary.

### Public surface

The spec lists the complete proposed surface, named consumers and stability.
Commands stay under `farmslot recipe run`, `artifacts`, and `status`, with
`farmslot doctor --conformance --live` for verification. There is no recording or
evidence command family beside the single recipe CLI.

`@farmslot/protocol` owns serialized contracts. `@farmslot/recipe-runner` owns
execution and built-in platform capture. `@farmslot/adapter-sdk` exposes engine
composition, one shared evidence review model and bounded-log capture. A harness
implements ProjectRuntime and domain actions; capture, clips, AC derivation and
package validation are inherited.

Move generic Android segment/cleanup mechanics and bounded-log capture onto
these public surfaces. Move Perps-specific performance assertions into their
domain library. Delete the corresponding harness implementations and old import
paths, without re-export shims. Generate CLI reference entries from the command
definitions; maintain concepts, SDK contracts and project-adoption guidance with
the implementation.

## Alternatives considered

### Why this architecture

1. **One recording plus derived moments.** Reject pre-encoding a separate clip per AC: it multiplies storage and encoding cost. Virtual clips are immediate; export encodes only requested moments.
2. **Measured ranges and immutable identity.** Reject process-start offsets, FPS arithmetic and independently stored AC timestamps: drift or retries can point reviewers at another event.
3. **Engine-owned automation.** Reject template wrappers and per-harness evidence writers: even a correct copy requires special instructions and can bypass cleanup or admission.
4. **Shared model, native presentation.** Reject a new cross-platform player framework. Reuse the web/native renderers with one validation, selection and seek implementation.
5. **Explicit incompleteness.** Reject silent screenshot-only success when required video fails. Reviewers need the failure and retained partial evidence, not an invented complete package.

## Consequences

- Recipe authors describe actions and AC proof intent, not evidence plumbing.
- Engineers review the same moment and identity in every client and publish gate.
- Always-on UI capture adds bounded cost and requires qualified platform backends.
- Typed AC moments and public engine composition require a versioned migration.
- Clip export and retention need explicit resource accounting; public media selection still requires normal authorization.

## Migration

1. Establish public contracts, one engine lifecycle, timing-capable backends and automatic AC derivation. Qualify the performance budgets through conformance.
2. Adopt immutable packages and AC moments in Command Center, Companion and publication/refresh. Preserve completed-run evidence and approval history.
3. Cut farms and custom harnesses over to declarative ProjectRuntime. Remove external recorders, PID/kill/trap/moov instructions, video-only copying, normal manual verdict steps and private imports. Delete the old implementations, not merely their callers.

Use a one-time data migration for existing ledger relationships that can be
verified. Keep legacy media available as historical untimed artifacts when its
clock or identity cannot be recovered; never manufacture ranges. No runtime
compatibility shim or duplicate format/writer remains after cutover.
