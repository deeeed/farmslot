# Recorded run evidence

**Status:** Proposed normative specification, pending acceptance of [ADR-062](../adr/062-recorded-run-evidence.md).
**Owner:** Farmslot maintainers.
**Scope:** Recipe evidence generation, SDK/CLI, publish gates and consumers. This reference defines the proposed contract; it does not describe every requirement as shipped.

MUST, MUST NOT and SHOULD are normative. The implementation and generated
reference must change together; the private current-state inventory is separate.

## Concepts

A recipe execution is one attempt against a resolved runtime. Recording captures
that attempt. A timeline maps individual node occurrences to the video's measured
clock. Nodes declare `proves` AC IDs; the engine derives each AC's result and
evidence moments. A claim can be an AC, QA case or QA check. Each uses the same marker, verdict and moment model. A moment selects a bounded clip and representative still. The
publish gate shows these automatically, then freezes the reviewed selection.
Projects declare runtime capabilities and targets; they do not manage recording.

## Artifacts and one owner per fact

| Fact/artifact                                                    | Authority                              | Required relationship                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Execution identity, node outcomes and intent, `trace.json`       | RecipeEngine trace writer              | One attempt ID; trace index distinguishes repeated/composed node visits.                               |
| Source video and native timing facts                             | Platform recorder through RecipeEngine | Finalized bytes, source-clock measurements, target and provider identity.                              |
| `<video>.timeline.json`                                          | Runner timeline writer                 | Video and trace digests match; all mapped ranges derive from those sources.                            |
| `artifact-manifest.json`                                         | Runner artifact writer                 | Recording, timeline, trace and derivative paths belong to the same immutable attempt.                  |
| `acceptance-status.json`                                         | Shared acceptance writer               | Verdicts derive from prover outcomes; moments reference the execution and trace index.                 |
| Clips and stills                                                 | Runner evidence derivation             | Each derivative identifies source digest and marker selection; it never becomes a new clock authority. |
| Publication selection, `evidence-manifest.json` and gate package | Gateway publication pipeline           | Selected media and internal validation dependencies preserve one snapshot identity.                    |
| Availability, expiration and pinning                             | Artifact storage                       | Package dependencies are retained or expired together; clients show unavailable evidence explicitly.   |
| HUD/caption                                                      | Traced recipe intent                   | Both are projections of the same intent; a caption is not proof of rendered pixels.                    |

### Contracts

Keep `RecipeRecordingTimelineDocument`, `RecipeRecordingMarker` and
`RecipeVideoTiming` in `@farmslot/protocol`. Their measured `framesMs`, duration,
clock bounds, `videoDigest`, `traceDigest`, `traceIndex`, `nodeId`, intent/proves,
and `startRangeMs`/`endRangeMs` remain authoritative. Do not replace ranges with
guessed scalar times. A marker outside recorded footage remains unrecorded.

Add protocol-owned `EvidenceClaimRef` with stable ID, kind and optional parent claim ID, and `EvidenceMomentRef`, identifying `{ recipeRunId, videoDigest,
traceIndex }`, and typed ledger evidence distinguishing a moment from an ordinary
artifact reference. Node IDs, captions and time ranges are derived projections
from the referenced validated marker, not repeated stored facts. A moment may
carry a selected start/end phase; a multi-node AC carries multiple references.

Add protocol-owned `RecordedEvidencePolicy` and `RecordedEvidenceState`. Policy
holds recording mode, reason for explicit off, target/backend constraints and
resource limits. State distinguishes not-required, explicit-off, recording,
finalizing, complete, incomplete and failed. It records reasons and artifact
references, not another copy of timeline timestamps. Both contracts are proposed.
Protocol schemas/version tags and ledger version MUST change when required. The versioned ledger generalizes the existing `acceptance-status.json` artifact to claims; it is the single writer/store for AC and QA evidence, not an additional QA ledger.

The selected attempt MUST be explicit. A consumer MUST validate schema, video
path/digest, trace digest, marker identity and clock ranges before seeking.
Replacing an artifact index hash to silence a mismatch is forbidden. Publication
refresh MUST preserve historical approval and PR code identity.

## Automatic claim evidence, ACs and QA

Recipe nodes declare registered claim IDs through `proves`: AC IDs for dev/fix, and QA case/check IDs for QA. Child check results derive the parent case verdict; failed or missing required checks cannot yield a passing case. The engine
normalizes positional AC spelling, executes proof nodes, and writes the ledger
after evidence finalization. It derives the verdict from all declared prover
results, with failing/missing provers and unavailable required visual evidence
shown explicitly. A passed recipe proof is not a human visual-review approval.

Repeated visits are resolved within the selected attempt using trace indices;
sibling runs MUST NOT satisfy another attempt's AC. The engine derives bounded
clip ranges and stills for visual proof, and structured result/log evidence for
state proof. Multiple moments remain selectable. An AC with no declared proof is
missing, not silently omitted. Manual `ac set` MUST only override an untestable
case with a reason and audit trail; it MUST NOT manufacture a normal proven result.

Clip boundaries conservatively cover the selected marker's measured start/end
ranges and are limited to available footage. The default player presents that
virtual segment immediately. A representative still uses a recorded frame within
the proof range, with source provenance; it MUST NOT be mislabeled as a native
snapshot. When no eligible frame exists, evidence is incomplete. Do not capture
unrelated screens or fabricate pixels to fill the gap.

## Lifecycle, failure and retention

1. Planning resolves composed UI actions, AC proof intent, policy, backend and target. Planning and discovery do not start capture.
2. Execution acquires scoped resource claims, checks readiness and starts one recorder before UI proof. Missing/ambiguous targets and unavailable required capture refuse execution with a diagnostic.
3. Each node result creates its trace/marker input. The HUD uses that node's intent where supported. State-only/headless recipes require no video.
4. Render and acknowledge the terminal HUD while capture is active. Stop and flush once, measure final frames, freeze trace/video identity, then derive the timeline, AC references and stills.
5. Publish the package atomically. The gate MUST not mix a newer video with an older index/trace. Abort/interruption finalizes usable partial footage and releases only owned processes/leases.

Capture failure is an environment/evidence failure, separate from product-node
outcomes. Preserve typed interruption and weak/incomplete evidence semantics;
required missing video/timing prevents a complete visual-proof claim. An explicit
off policy is visible at the gate and does not satisfy a video-required AC.

The default profile is at most 15 FPS and a 1080-pixel maximum edge. Proposed
conformance budgets, not current measurements, are:

| Cost            | Budget on each advertised target/backend                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture CPU     | Mean additional CPU ≤5% of one logical core; one-second p95 ≤20%, measured over a 60-second UI recipe against recording-off baseline.                                                     |
| Disk            | Encoded video average ≤10 MiB/minute; transient spool ≤32 MiB; timing/index metadata ≤128 KiB/minute.                                                                                     |
| Time            | p95 added node latency ≤25 ms; recording start ≤500 ms; finalization plus automatic still derivation ≤2 seconds for the 60-second qualification recipe.                                   |
| Clip derivation | Virtual boundaries ≤5 ms per proof node. No ahead-of-time per-AC encoding. Requested 10-second clip export ≤2 seconds p95, one materializer at a time, cached by source digest and range. |

Quality qualification MUST confirm readable HUD and target text. A backend that
misses these budgets is not advertised as conformant; there is no silent backend
fallback. Node limits for duration/bytes use configured policy and MUST stop with
an explicit partial/limit result rather than consume unbounded storage.

Source packages remain pinned while an unresolved gate or published-evidence
reference depends on them. Completed unpinned packages default to 30-day local
retention; artifact-storage policy may override it. Expiration MUST remove the
dependency closure atomically and preserve an unavailable record. Temporary
staging is deleted after finalization/abort. Requested derivative clips share the
source package's lifetime. Retention does not delete independently hosted public
evidence or rewrite PR bodies.

## Declarative project adoption

ProjectRuntime declares recording support, target resolution, backend family,
resource claims, HUD capability and policy. Values resolve from explicit operator
settings, runtime binding and pool/slot configuration. No personal paths, machine
names, PID-file reads or recorder subprocesses belong in templates or recipes.

UI recipe recording defaults on; no worker instructions or flag are required.
An explicit operator/project off policy requires a reason. New projects implement
runtime/action bindings; new platform backends implement the public recording
contract once. Custom harnesses inherit lifecycle, timestamp mapping, AC
derivation, clips/stills, cleanup and package generation from the same engine.

## Public surface

All entries below are proposed unless already exported; acceptance MUST establish
one supported package entry point per helper. Every new entry has a named consumer.

### CLI

| Surface                                        | Consumer and behavior                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `farmslot recipe run <id                       | file>`                                                                                                                            | Workers and custom harness users; UI recording and full AC evidence are automatic. Existing plan mode remains read-only. |
| `--record-video=off --recording-reason <text>` | Operator opt-out and performance-baseline qualification; reason is retained. No normal recipe-author instruction depends on this. |
| `farmslot recipe artifacts [dir                | task] --validate --format json                                                                                                    | markdown`                                                                                                                | Gates, CI and publication; validates the dependency closure and renders AC moments/gaps. |
| `artifacts --ac <id> --export-clips <dir>`     | Engineer/release evidence export; materializes only requested AC clips/stills through the runner.                                 |
| `artifacts <task> --refresh-published`         | Authorized operator; invokes the existing published-evidence pipeline with identity/race checks, never a hand-edited body.        |
| `farmslot recipe call <action> [k=v]`          | Domain recipes and operator diagnostics; registered actions consume SDK evidence/log helpers without a second command family.     |
| `farmslot recipe status`                       | Engineer; reports capture/completeness/last package.                                                                              |
| `farmslot doctor --conformance --live`         | Project/platform maintainer; qualifies backend correctness, cleanup and budgets.                                                  |

No parallel `record`, `video`, or `evidence` command family. Size/FPS/retention
settings are policy, not a new collection of worker flags. CLI execution calls
the same public SDK used by consumers.

### SDK contracts, helpers and versioning

| Package/export                                                                                                                                                                                                                                   | Named consumer                                                                                      | Stability and ownership                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`: existing timeline/marker/video/artifact contracts, published-refresh RPC types and validator; proposed `EvidenceClaimRef`, `EvidenceMomentRef`, `RecordedEvidencePolicy`, `RecordedEvidenceState`, ledger evidence version | Runner, gateway, both clients                                                                       | Serialized, versioned contracts; existing timeline v1 retained, incompatible ledger changes require a version migration.                             |
| `@farmslot/protocol`: proposed public `ProjectRuntime`, `RecipeEngine` boundary contracts                                                                                                                                                        | SDK engine, recipe-cli, custom harnesses                                                            | One declaration per contract; moves the currently internal engine boundary into the documented provider surface. No second implementation/type copy. |
| `@farmslot/adapter-sdk`: `createRecipeEngine`                                                                                                                                                                                                    | recipe-cli and custom harness composition                                                           | Proposed public factory over the existing runner; owns composition, not another engine.                                                              |
| `@farmslot/recipe-runner`: existing `createRecipeRunner`, `VideoRecorder`, recording-target contracts and built-in backend factories                                                                                                             | SDK and platform-provider authors                                                                   | Public execution/backend API; automatic evidence is inherited. Contract types move/re-export from protocol as appropriate, with one definition.      |
| `@farmslot/adapter-sdk/evidence`: `createEvidenceReviewModel`, `validateRecordedEvidencePackage`; model methods own selection/seek/frame traversal                                                                                               | artifact CLI, gateway, Command Center PR preview/Run Detail/lightbox, Companion gate/ArtifactViewer | Proposed public model and validator; portable build, one implementation, no copied formulas.                                                         |
| `@farmslot/recipe-runner`: `materializeEvidenceClip`                                                                                                                                                                                             | artifact CLI and authorized publication                                                             | Proposed bounded export helper; input is a validated moment/package, output is a registered derivative.                                              |
| `@farmslot/adapter-sdk`: `refreshPublishedEvidence`                                                                                                                                                                                              | Authorized artifact CLI and harness publication integrations                                        | Proposed public client entry to the existing typed gateway RPC; no independent uploader/body editor or authority bypass.                             |
| `@farmslot/adapter-sdk`: `createLogEvidenceWindow`                                                                                                                                                                                               | Perps performance action and other runtime-log assertions                                           | Proposed generic bounded log/source-identity capture. Domain event names, measurements and assertions stay in libraries.                             |

The ADR/spec approval does not make an unimplemented export stable. Mark new
entries experimental until their conformance passes; promote them with a documented
package release. Compatible additions use normal package versioning; incompatible
public signatures use the next breaking release and a clean coordinated cutover.
No `/src`, `/harness`, implementation-file imports or obsolete re-export shims
remain in adopters. Browser/native clients receive only the portable entry point.

Harness extension points are target resolution, action handlers, domain libraries
and declared resource/HUD support. Capture backend authors implement recorder
start/snapshot/stop/timing/cancellation once per platform. Ordinary harnesses MUST
NOT implement their own recorder, marker math, clipper, ledger writer or publisher.

### Harness migration and documentation

Move Android segmented screenrecord mechanics into the shared platform backend,
consume it through engine composition, then delete the harness's
`android-screenrecord.ts` and obsolete recording orchestration. Preserve segment
gaps, scoped device identity, interruption evidence and signal cleanup.

Replace generic file-offset/source-identity handling in performance capture with
`createLogEvidenceWindow`. Move Perps-specific measurements into the domain recipe
library, then delete the old harness `performance-capture.mjs` and
`capture_performance.mjs` implementations/import paths. Application audio recording
and Perps assertions are not replaced by UI video capture.

Documentation MUST include this reference, the concepts above in the recipe
concepts guide, SDK contract/examples, declarative project-adoption tutorial, and
generated CLI entries for run/artifacts/status/doctor. Generate CLI syntax from
the single command definitions; do not maintain a parallel handwritten command
reference. No new flag/export without a consumer listed here.

## Shared evidence review model

One `createEvidenceReviewModel` instance owns the current package's claims,
verdicts, clips/stills/markers, caption and selection/seek ranges. Its context is
`gate-review`, `run-detail`, `pr-preview` or `artifact-viewer`; context changes
presentation, never identity validation or verdict derivation. It exposes actions
for selecting a claim, check, recipe occurrence or moment, and resolves missing
proof explicitly. Project/harness code does not supply a second implementation.
Lit and React Native render its state and forward player events only.

Current duplicate projections/selectors to replace, all under the repository root:

| Current source                                                                                                  | Replacement responsibility                                                          |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/command-center/ui/src/components/shared/artifact-lightbox-model.ts:9`                                     | Generic URL/path-only media mapping.                                                |
| `apps/command-center/ui/src/components/runs/run-detail-model.ts:217`, `:256`                                    | Separate run-item/AC-file mapping and caption composition.                          |
| `apps/command-center/ui/src/components/workspace/ready-workspace-lightbox.ts:40`                                | Gate/PR-preview-specific media selection.                                           |
| `apps/command-center/ui/src/components/shared/media-lightbox-video-model.ts:46`, `:65`; `media-lightbox.ts:472` | Validation, marker seeking and initial-marker selection move into the shared model. |
| `apps/companion/src/features/artifacts/ArtifactViewerScreen.tsx:425`                                            | Independent artifact-to-player mapping that drops marker identity.                  |
| `apps/companion/src/features/decision-workspace/components/decision-workspace-panels.tsx:740`, `:887`           | Gate-specific preview mapping/pair selection.                                       |
| `apps/companion/src/features/slot-workspace/components/slot-workspace-panels.tsx:1112`                          | Separate slot/workspace evidence selection.                                         |

### QA and step-to-proof traversal

A composed QA recipe with 10+ cases MUST automatically produce case/check verdicts
and evidence moments. Both `engine_output_review` clients receive the retained
report digest and output manifest, show cases/checks with pass/fail/missing state,
and open each at its bounded clip. Selecting a recipe node traverses through its
claim and trace occurrence to the same evidence, or an explicit missing-proof
state. The report and gate acknowledge the same snapshot. This closes Companion's
missing output-review snapshot, verified marker navigation and step-to-proof
traversal; it does not replace another gate's existing approval guard.

Long recording limits apply per segment, default 10 minutes or 100 MiB, with
shorter platform limits permitted. A backend MUST preserve per-segment clock
alignment and report gaps rather than fabricate continuity. A moment spanning
segments has ordered references to each segment; virtual playback and export
cover the complete bounded interval. Export may read only the affected segments.
Marker lookup MUST be indexed and ≤10 ms p95 for a 100-case/10,000-marker package;
opening a case MUST NOT download/decode the whole recording. Use seekable media
and authenticated byte-range delivery. Source size remains bounded by the
execution's explicit duration/byte policy, not by the number of claims/clips.

## Consumers

Command Center and Companion MUST present all registered ACs at every publish
gate, including missing/untestable/incomplete results. One action opens a bounded
clip at the validated moment, shows its still and intent, and stops at its end.
Both use the same identity checks, selection and seek model with native rendering
wrappers. Reload/deep links retain execution/marker identity, not raw credentials.

PR bodies come only from the authorized pipeline. Generate AC evidence links and
requested hosted clips from the frozen package. Use `#t=` only on a host whose
seek support is demonstrated; otherwise use an honest media link and configured
gate/moment link. Do not put tokens or private trace logs into public artifacts.
`refreshPublishedEvidence` retains its approval, run/PR identity and concurrent
body-change checks; refresh cannot mix evidence revisions or change source code.

## Conformance checks and testable requirements

- **P1:** Executing a plain UI recipe produces video, valid timeline, clip boundaries, stills, captions and links without any recording/timestamp/linking code in the recipe or template; inspect the final package and command journal.
- **P2:** Nodes' `proves` values generate every registered AC verdict and moment automatically; failing/missing provers and interruption produce the expected incomplete outcomes. A manual normal proven verdict is refused; an untestable override is audited.
- **P3:** The live qualification recipe meets every budget above and text remains readable. No per-AC encoded clip is created until requested; repeated export reuses a digest/range-matched derivative.
- **P4:** A custom harness using only public ProjectRuntime/RecipeEngine composition produces the same complete package and cleanup as direct/hosted recipe CLI, with no recording implementation in the harness.
- **P5:** Give a minimally capable recipe-writing worker only the task ACs and action catalog, with zero evidence instructions. Its minimal positive and deliberately failing UI recipes produce the full package automatically; real Command Center and Companion gates show every AC with its clip or explicit failure. Retain the prompt, recipe, package and gate interaction proof privately.
- **P6:** An engineer can open each AC clip from either gate in one interaction, see the matching still/HUD intent, and replay its bounded range. Cold marker resolution p95 is ≤2 seconds on the configured local gateway; subsequent selection is ≤250 ms, excluding network transfer outages.
- **P7:** Build a consumer using only documented package exports and the single CLI; exercise recording, validation, AC selection, clip export, log capture and authorized refresh. A source/import scan finds no adopter import of internals or copied implementation.
- **Identity:** Wrong video/trace digests, stale indices, missing sidecars, repeated/composed node IDs, sibling attempts and out-of-footage markers cannot open a false evidence moment. The valid source/old-index mismatch case remains a visible refusal.
- **Lifecycle:** Real abort, interruption, limit exhaustion and recorder conflict retain honest partial evidence, flush usable media and leave no owned recorder, temporary spool or lease. No unrelated process or lease is stopped.
- **Adoption:** One UI recipe per advertised browser/simulator/device target passes through the public engine; command-only Core remains an unrecorded control. Qualify each target independently, not by another platform's success.
- **Migration:** Adopted templates have no recording/verdict plumbing; old screenrecord/performance-capture/private entry points and video-only promotion are deleted. Converted ledgers preserve verified relationships; untimed historical media remains explicitly untimed, with no runtime compatibility shim.
- **Publication:** Pipeline output renders in PR/gate preview, hosted media returns HTTP 200, supported offsets open the correct moment, unsupported hosts are labeled honestly, and refresh preserves approved selection and PR identity.

- **Shared model:** Tests feed the same package/selection through every call context and both platforms and observe identical claims, moments, captions and seek bounds; scans find no duplicated evidence mapper/selector.
- **QA:** A real composed recipe with 10+ cases, mixed passing/failing checks, multiple recordings and a segment-spanning check generates case/check verdicts, clips/stills and report links automatically. Real Command Center and Companion output-review gates open every case/check at the verified moment; missing proof is visible and the acknowledged report digest stays pinned. Measure segment size, indexed seeking and range-request cost under P3.
