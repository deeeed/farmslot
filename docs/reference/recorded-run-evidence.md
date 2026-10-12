# Recorded run evidence

**Status:** Accepted normative specification for [ADR-062](../adr/062-recorded-run-evidence.md).
**Owner:** Farmslot maintainers.
**Scope:** Framework recording, claim evidence, review consumers and public CLI/SDK.

MUST/MUST NOT are requirements. New contracts/APIs below are proposals, not
shipped guarantees. Current implementation references and adopter deletion lists
are separate from this public contract.

## Concepts and ownership

A recipe execution is one attempt. A claim is an AC, QA case or QA check declared
in `proofTargets`. An executed expectation can prove a claim; navigation and
screenshots alone cannot. A moment refers to a recording marker. A clip is bounded
playback of that moment, optionally exported. A gate freezes the selected package
and presents every claim with its result and evidence.

| Fact/artifact                                                                | Sole authority                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| Intent, `proves`, qualified node occurrence and assertion observation/result | Execution trace writer, `trace.json`                  |
| Captured bytes, source timing, capture start/stop and segment order          | Recorder through RecipeEngine                         |
| Media-clock mapping and occurrence ranges                                    | Timeline writer, `<video>.timeline.json`              |
| Immutable files, digests and dependencies                                    | Artifact writer, `artifact-manifest.json`             |
| Registered claim verdicts and moment references                              | One ledger writer, versioned `acceptance-status.json` |
| Frozen publication selection                                                 | Publication pipeline, `evidence-manifest.json`        |
| Pinning, availability and expiration                                         | Artifact storage                                      |

A stored digest is a checked reference to immutable bytes. Marker intent/action/
`proves` fields are projections validated against the trace, not another owner.
The HUD uses traced intent. Remove independent publication `covers`, stored AC
clock values and separate HUD captions; clients derive them from the claim/trace
relationship. Internal validation dependencies are not automatically public.

## Claim registration and verdicts

Extend the existing `proofTargets` declaration with claim kind, optional parent
ID and proof mode. Root AC IDs are registered from task input; recipe declarations
must match them. Standalone/QA claims register from that declaration. Duplicate,
unknown, cyclic-parent and conflicting declarations fail planning. Nodes' `proves`
values resolve only to registered claims.

Composition qualifies child claims/nodes with the call path. Each repeated call
iteration has its own qualified identity; intentional binding to a parent claim
is explicit in the call's claim bindings. The engine derives required occurrences
from the resolved execution plan. A skipped required occurrence is missing;
a plan-declared non-required branch is not evidence. Another execution or sibling
attempt cannot satisfy this attempt.

Reuse the existing executed-runtime-proof checks. Only a registered assertion
handler with an actual expectation and validated observation/result is eligible.
An output assertion needs a preceding observation in this attempt; a structured
artifact assertion needs its indexed proof artifact; a UI expectation needs the
actual input/observation it checks. A call proves through an eligible executed
child assertion. `proves` on an assertion-free action or screenshot is rejected
at preflight and cannot yield proven evidence if preflight is bypassed.

For a declared retry group, the last eligible executed assertion result determines
that occurrence; earlier results stay in the trace. An ordinary repeated iteration
is a separate required occurrence, not a retry that hides an earlier failure.
All required occurrences must satisfy the claim. QA cases use the same reducer
over their required child checks.

| Required facts                                                            | Derived verdict   |
| ------------------------------------------------------------------------- | ----------------- |
| Executed eligible expectation fails                                       | `failed`          |
| Required prover/occurrence never executes or no eligible prover exists    | `missing`         |
| Expectations pass but required media is absent or outside recording       | `weak`            |
| State expectations pass, with their required evidence                     | `proven`          |
| Visual/mixed expectations pass with media but no recorded visual judgment | `awaiting-review` |
| Required visual judgment confirms the claim and assertions pass           | `proven`          |
| Recorded visual judgment rejects the claim                                | `failed`          |
| Authorized untestable override with reason/audit trail                    | `untestable`      |

A parent is proven only if all required children are proven; otherwise use the
first applicable result in this order: failed, missing, weak, awaiting-review,
untestable. Untimed media remains visible and its timing limitation is separate
from the claim's semantic verdict. A passed action, screenshot or overall gate
acknowledgment is never a substitute for the eligible assertion/visual judgment.
Manual `ac set` becomes an untestable override only, with actor, reason and prior
state; it cannot set a normal proven verdict.

Examples the reducer MUST satisfy: failed then passed in one declared retry group
uses the final result and retains both; a failed independent iteration still
fails; a skipped required check is missing; two composed calls use different
qualified occurrences; a successful sibling attempt leaves this attempt unchanged.

## Recording and moment contracts

Keep the measured timeline/marker abstraction and digest checks. A marker retains
`traceIndex`, qualified `nodeId`, result projections and existing `startRangeMs`/
`endRangeMs`. The timeline maps the final trace to a particular video's digest.
Version validators and serialization when segment/claim relationships require it;
do not promise unchanged validation while changing these relationships.

Protocol-owned `EvidenceMomentRef` identifies execution, video digest and trace
index. Ledger entries carry artifact or moment references, not independently
stored milliseconds. Ordered segment references identify original media, timeline
and digest; one segment uses the same list. The recorder result must return that
list rather than only one file. Independent segment clocks retain their existing
measured timelines. Restart gaps or held-frame padding are not captured proof;
an affected visual moment is outside recording. A continuous segment boundary
may yield ordered moment references. Export reads only those source segments.

**Timing rule:** Capture starts before the first UI proof node and stops after the
final HUD outcome. Play `[startRangeMs[0] - 1000, endRangeMs[1] + 1000]`, using one
shared `EVIDENCE_PADDING_MS = 1000` constant and limiting padding to available
media. Do not trim an out-of-span proof into valid evidence: a proof node outside
the captured span is `outside recording`. If its range was not measured, show
`untimed`, retain its media/still/intent, and offer no marker seek. Never invent an
offset. This is a lifecycle/measurement rule only; no accuracy threshold,
precision machinery or per-backend clock qualification is added.

Stills are derived from original recorded frames associated with the moment and
retain source provenance; they are not mislabeled as native snapshots. A missing
frame remains missing evidence. The HUD renderer remains; the engine publishes
its final outcome before stopping capture. No unrelated image fills a proof gap.

## HUD requirements

The HUD MUST display the complete node intent, wrapping to at most two lines,
without ellipsis, clipping or truncation mid-sentence. Its bounded panel MUST
preserve app visibility and MUST NOT obscure the app content being checked.
Each node intent MUST be one concise sentence. Intent lint MUST warn above
80 characters and fail above 120 characters. Harnesses MUST inherit the shared
framework HUD; per-harness HUD renderers are forbidden.

## Lifecycle, resource limits and retention

Planning/discovery are read-only. Execution resolves target/policy, applies the
same scoped admission for direct SDK and hosted callers, and owns one capture
session. Backend/target conflict keys distinguish independent capture resources;
a helper name alone is not a fleet-wide lock. Only authorized execution acquires
claims. Ambiguous/unavailable required targets fail clearly.

The engine owns snapshots, cancellation, final HUD, stop/flush, timeline/claim
finalization and atomic publication of the execution package. No separate CLI
framed lifecycle remains. Capture failure is an evidence/environment failure,
not a product regression. Preserve usable partial footage and typed interruption;
abort releases only owned processes/leases and staging.

Default UI policy records without author instructions, at ≤15 FPS and a 1080-pixel
maximum edge. Explicit operator off requires a reason and appears at the gate.
Headless state-only execution does not require video. Proposed performance
budgets count the recorder, encoder and automatic derivation together:

| Cost            | Acceptance target                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU             | Mean added CPU ≤5% of one logical CPU; one-second p95 ≤20% against recording-off baseline                                                                     |
| Disk            | Encoded average ≤10 MiB/min; spool ≤32 MiB; metadata ≤128 KiB/min                                                                                             |
| Time            | p95 added node latency ≤25 ms; start ≤500 ms; finalization/stills ≤2 s for a 60-second UI qualification recipe                                                |
| Derivatives     | Virtual boundary derivation ≤5 ms/node; requested 10-second clip export ≤2 s p95, one materializer, cached by digest/range                                    |
| Seeking         | Indexed lookup ≤10 ms p95 for 100 cases/10,000 markers; no whole-recording decode/download to open a case                                                     |
| Client transfer | Zero media bytes/players for unselected cases; selected startup ≤2 MiB and read-ahead ≤4 MiB; first bounded playback ≤3 s on 10 Mbit/s, 50 ms round-trip link |

These are unmeasured targets. Qualify a short recipe and a long segmented QA
suite, including readability, live capture and requested export. CDP capture MUST
encode progressively or use a bounded spool, rather than store every PNG until
stop. Native clients initialize only selected playback. Keep authenticated byte-
range delivery. No silent backend fallback hides a failed budget.

Default total limits are 120 minutes or 1 GiB per execution; segment limits are
10 minutes or 100 MiB, with shorter platform limits permitted. Exceeding a total
limit finalizes partial media and reports the limit, not unbounded growth.
Encoding separate clips in advance is forbidden; virtual clips/stills are derived
automatically, exported clips only when requested.

Pin the dependency closure for unresolved gates and approved published references.
Unpinned completed packages default to 30-day local retention, overridable by
storage policy. Expire their dependencies together and preserve an unavailable
record. Derivatives share the source lifetime. Delete temporary staging on stop/
abort; local expiration does not delete independently hosted public evidence.

## Public surface

### CLI

| Surface                                                                    | Named consumer                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `farmslot recipe run <id\|file>`                                           | Recipe authors/custom harness users inherit evidence automatically; existing plan mode stays read-only |
| `--record-video=off --recording-reason <text>`                             | Operator exception and performance-baseline qualification                                              |
| `farmslot recipe artifacts [dir\|task] --validate --format json\|markdown` | Review gates, CI and authorized publication                                                            |
| `artifacts --ac <id> --export-clips <dir>`                                 | Engineer/release export; selector accepts the registered claim ID, including QA                        |
| `artifacts <task> --refresh-published`                                     | Authorized operator refresh against the approved package                                               |
| `farmslot recipe status` / `farmslot doctor --conformance --live`          | Engineer readiness and maintainer conformance                                                          |

There is no parallel recording/evidence command family or new routine worker
configuration. SDK and CLI call the same engine. Generate reference entries from
these single command definitions; concepts, public SDK examples and declarative
adoption guidance ship with their behavior.

### SDK contracts and migration

Serialized evidence belongs to `@farmslot/protocol`: existing timeline/artifact
contracts, and proposed claim registration/ledger, moment and ordered-segment
references, recording policy/state and refresh DTOs. These are versioned data
contracts consumed by engine, gateway and both clients. Executable provider and
engine contracts belong in `@farmslot/adapter-sdk`; `ProjectRuntime` denotes the
runtime role represented by the existing provider contract, not a second protocol
interface to implement.

| API/signature                                                                                                                     | Owner and consumers                                                                       | Status/replacement                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdapterRecording.target(context): Promise<RecordingTarget>`; `videoRecorder(): Promise<VideoRecorder>`                           | `@farmslot/adapter-sdk`; engine and platform providers                                    | Evolve existing contract; target resolution stays provider-owned                                                                              |
| `VideoRecorder.start(request): Promise<ActiveVideoRecording>`; `stop(): Promise<VideoRecordingResult>` returning ordered segments | Executable backend contract in the SDK; runner/platform backends                          | Version changed result shape; keep one definition and built-in backends                                                                       |
| `createDefaultRecipeEngine(options: DefaultRecipeEngineOptions): RecipeEngine`                                                    | Proposed `@farmslot/adapter-sdk`; CLI and custom harness composition                      | Existing public export is `@farmslot/recipe-cli/harness`; move only these engine factory/types in coordinated breaking release, no alias shim |
| `createEvidenceReviewModel(input): EvidenceReviewModel`; `validateRecordedEvidencePackage(package): ValidationResult`             | Proposed `@farmslot/adapter-sdk/evidence`; every review context, artifact CLI and gateway | Portable model/validator; methods own claim/step selection, caption, seek and bounded playback state                                          |
| `materializeEvidenceClip(package, moment, outputDir): Promise<ArtifactRef>`                                                       | Proposed `@farmslot/recipe-runner`; artifact CLI/publication                              | Bounded on-demand derivative from validated references                                                                                        |
| `refreshPublishedEvidence(client, params): Promise<RunRefreshPublishedEvidenceResult>`                                            | Proposed SDK client entry; authorized artifact CLI/integrations                           | Existing typed gateway RPC remains sole publication authority                                                                                 |

`readRecordedEvidencePackage(artifactDir)` is the single Node filesystem reader
exported from the Node entry `@farmslot/adapter-sdk`. CLI artifact validation and gateway
gate evaluation use its `{ input: RecordedEvidencePackageInput, checks }` result.
Consumers reject any failed read check and pass `input` to
`validateRecordedEvidencePackage`; callers may bind the expected `recipeRunId`
without replacing retained identity. The reader hashes actual contained bytes and
loads the retained invocation, claims, dependency recipes and declared timelines.
It does not select a publication, derive a second verdict, or replace a missing
retained recipe. The portable `@farmslot/adapter-sdk/evidence` entry exports the validator without filesystem code. This
experimental export ships with the coordinated ADR-062 package release.

Existing supported exports are not internal merely because a path contains
`/harness`. Remove only replaced exports/imports and implementation-file access.
New entries remain proposed/experimental until conformance and a documented
release. Required incompatible changes use a coordinated breaking package release
and one-time data migration; no runtime compatibility writer/format remains.

A harness implements target/action bindings and declares recording/HUD/resources;
it inherits capture, assertions-to-verdict derivation, moments/stills/clips,
cleanup and package generation. Backend authors implement recording once per
platform. A harness does not implement its own recorder or publisher. Unrelated
domain log/performance assertions are outside this recording feature.

## Consumers and publication

One portable review model serves gate review, run detail, PR preview and artifact
viewing. Only rendering/player controls differ between Lit and React Native.
Replace copied artifact/claim mappings and initial-selection/seek state; context
cannot weaken identity or verdict rules. Show node intent → expectation → claim
beside each claim, with all missing/untestable/awaiting-review states visible.
Selecting a recipe occurrence opens its mapped evidence or a missing-proof state.

Long QA uses the same registered claims and required checks. Both output-review
gates list case/check results, retain report digest/output manifest, and open each
bounded clip. Acknowledgment refers to that snapshot; it does not authorize release.
No separate QA reducer, store or player exists.

The publication selector MUST use the approved immutable dependency closure,
including derivative source identity. Refresh MUST refuse substituted bytes,
unapproved selection and stale/missing approved dependencies. Current mutable
files are not authority for approved refresh. Keep PR/run identity and concurrent
body/head-change checks; refreshing never reopens approval or changes code.

Generate PR links/clips only through the authorized pipeline. Use `#t=` only for
a demonstrated seekable host, otherwise media plus configured claim/moment links.
Never expose tokens/private traces. Removing duplicate `covers` requires the
ledger relationship to remain available to publication consumers.

## Migration and conformance

Until engine derivation passes conformance, manual verdict steps remain the sole
normal writer path. Then cut over once and remove those steps; never enable two
normal paths. Convert verified relationships once and retain other historical
media as explicitly untimed. Delete replaced external recorders, PID/signal/trap/
moov steps, manual linking, video-only promotion and private timestamp logic.
Specific adopter files and release coordination stay outside this public spec.

Named checks below are required before release; they specify proof, not existing
successful test results:

- **P1 timing/lifecycle:** Verify measured-range playback with the shared 1 s padding, capture before first UI proof, final HUD before stop, untimed/no-seek and outside-recording states on adjacent nodes and interruption. No invented timestamps or precision qualification.
- **P2 assertion eligibility:** Navigation-only and screenshot-only `proves` fail closed. Executed observation-bound assertions follow the verdict table; visual proof remains awaiting review until a recorded judgment. Untestable override cannot manufacture proven evidence.
- **P3 bounded cost:** Short and long QA satisfy all CPU/disk/time/transfer budgets, total/segment limits, progressive encoding, zero inactive media loading and requested-only encoded clip export.
- **P4 public composition:** A harness using only public runtime/engine bindings inherits the same evidence and owned-resource cleanup as SDK and hosted CLI; no recording implementation exists in the harness.
- **P5 minimal-author-evidence:** Record the actual minimal author model/version and prompt in private conformance evidence. Give it only task ACs, catalog and schema, zero evidence instructions. Its plain recipe yields every AC with HUD stills, clips/moments and visible checked expectations at both gates; required missing provers and a screenshot-only false claim remain unproven.
- **P6 shared review:** Every web/native context shows identical claims, verdicts, moments/captions and bounded playback. One interaction selects a claim or recipe occurrence; wrong video/trace digest, stale index and missing sidecars remain visible refusals.
- **P7 supported surface:** Exercise all listed CLI/SDK entries through public imports; replaced factory exports disappear in the coordinated release, other supported `/harness` exports remain valid, and generated reference matches commands.
- **P8 QA/occurrences:** A 10+ case suite covers failed-then-passed retry, failed independent iteration, skipped required check, composed calls and sibling attempt isolation. Continuous cross-segment proof opens ordered clips; restart/held-frame gaps remain outside recording. Both output-review reports jump to each case/check against the same report identity.
- **Frozen refresh:** Replace approved media bytes or request an unapproved artifact and observe refusal; valid approved refresh preserves selection, dependencies, approval and PR identity, and renders hosted media with HTTP 200.
- **Clean cutover:** One normal ledger writer, no replaced recorder/linking/mapper copies or shim imports; unrecorded headless control and explicitly untimed legacy viewing remain honest.
- **HUD:** Intent lint accepts 80 characters without a length warning, warns at 81–120 and fails at 121; multi-sentence intents fail. Across supported viewports the shared HUD displays the complete sentence in at most two lines inside its bounded panel, without hiding the checked app content. A harness inherits that HUD without supplying a renderer.

## Proposed amendment: historical review, chapters and footprint

Status: Proposed, 2026-10-12. The requirements below become normative when this
amendment is accepted. They add no capture clock or accuracy contract.

### Completed review binding

The default detail view for completed, failed and retrospective runs MUST show
final evidence and result through the existing gate review component in read-only
`as-decided` context. Bind it to the final applicable decision's existing frozen
package identity, closure, selected artifacts and recorded disposition. An output
acknowledgment binds its existing report/manifest snapshot and is not publication
approval. The selected snapshot, execution and claim IDs MUST remain visible.

Only selection, playback, navigation and authorized export are available. The
context MUST expose no gate-resolution, publication, rerun or verdict-writing
controls, and those operations MUST remain guarded at the authority boundary.
Diff, observability and analytics are one tab away. Refresh or current task edits
MUST NOT replace the snapshot on screen.

Without a frozen decision package, show `unreviewed evidence` or `legacy: no
frozen review`, plus available final artifacts. Never infer approval. Missing
recording, interruption, missing timeline and pruned media are distinct visible
states. Frozen claims and measured ranges remain unchanged when media is pruned;
seeking/export is disabled only for unavailable or incompletely covered sources.
Keep history metadata for the run's history lifetime. Dependency pins still
protect unresolved gates and required published references.

### Player and chapters

Where recorded claim markers exist, the shared player MUST be the main element
with a visible chapter list beside it, or directly below it on a narrow screen.
Use the existing claim hierarchy, verdicts, intents, expectations and moment refs.
Do not introduce chapter timestamps, another QA reducer or a chapter store.

Each chapter shows verdict and measured range(s). One selection opens its ordered
virtual clips using the existing padding and gap rules. Untimed or partly covered
claims remain listed and disabled for seek. Complete claims in a partial run may
still play. Selecting an unavailable claim shows its limitation rather than
silently selecting another chapter.

During selected-claim playback, that claim stays active through its ordered clips.
During free original playback, choose the deepest measured claim containing the
position, then latest measured start, then stable claim ID to resolve overlap;
show its ancestors without changing verdicts. Use the unpadded measured range for
this lookup. Padding overlaps do not create competing active chapters. The shared
model owns this rule and both renderers consume the same active ID. Initialize
only selected media and retain the existing transfer/seek budgets.

### Footprint contract and lifecycle

Proposed protocol-owned `RunDiskFootprint` is a storage projection on `Run`:

- `status`: `complete`, `stale`, `partial`, `unavailable` or `legacy-unknown`;
- `measuredAt` and the storage retention revision used;
- known byte totals for recording, stills/materialized clips, logs/transcripts and other retained artifacts;
- `totalBytes` only for a complete measurement, with unavailable-location count/reason otherwise.

The category sum is the known owned-byte count. A partial count is a labeled lower
bound; an unavailable or legacy total is not zero. Count regular-file lengths,
excluding directory/block overhead, sparse allocation and shared extents. Count
run-owned files in all retained locations, including cache/mirror copies and
managed execution logs/transcripts; exclude the application checkout and dependency
caches. Virtual clips add zero bytes. Storage assigns each shared object one
owner, and exposes referenced shared bytes separately from owned bytes. Per-project
history totals deduplicate storage objects, include all retained history rather
than just the listed page, and report unknown coverage.

Storage MUST publish a measurement at completion. Before a retention mutation it
marks the current projection stale; after the mutation it recomputes against the
new retention revision. Readers MUST label stale/partial data. Keep completion
measurement separate from current retained usage so pruning does not rewrite the
historical review. An offline location or failed stat produces an explicit
incomplete measurement and retry through storage, without changing the run verdict.

### Public surface and adoption

The existing run detail/list RPCs and SDK client methods expose footprint and final
review references, using additive `@farmslot/protocol` DTOs. `farmslot run get <id>`
is the existing detail/show operation and prints both; `run list` adds retained
bytes and its completeness state. Project-filtered history shows totals and
unknown coverage. `farmslot recipe artifacts` resolves completed task/run context
to its final snapshot for validation, claim selection and requested clip export;
it never silently falls back to current files.

The experimental SDK review model accepts completed/read-only context, frozen
snapshot identity and storage availability. Its existing claims and selection
methods drive chapters; active-claim lookup and availability are shared extensions.
Clients render the same claims/ranges, with platform-specific layout only. Runtime
providers inherit default UI capture, retention reporting and footprint projection;
authors add no recording, timestamp, linking or filesystem code. Generate CLI
reference entries with the implementation. Unavailable legacy coverage stays
explicit during migration; do not backfill fabricated review identities.

### Testable amendment requirements

- **H1:** Both clients reopen a completed approved run on the same final package, verdicts, expectations and evidence; current task edits and refresh cannot change it. Failed/rejected and report-acknowledged runs preserve their different dispositions.
- **H2:** All historical review actions are read-only. Attempts to resolve/publish/edit a historical snapshot through a client or SDK are refused by the authority boundary. Other tabs remain one action away.
- **H3:** A multi-case, segmented QA package shows every case/check chapter and exact range. Selection, playback transitions and overlapping ranges produce identical active IDs in both clients; untimed/outside/pruned entries remain visible without invented seeks.
- **H4:** UI recipes in development, bug-fix and QA inherit capture without author recording steps. Headless/no-UI and reasoned operator opt-out are explicit controls; target or capture failure is not silently omitted.
- **H5:** Completion and retention measurements equal known fixture file sizes by category; virtual clips add zero, physical copies count once, and shared references do not double project totals. Offline, stale and legacy measurements never appear as zero or complete.
- **H6:** CLI/SDK and both clients show the same current and completion footprint, final snapshot reference and project-history coverage. Pruning changes availability/current bytes while preserving the review's verdicts, timing metadata and original completion measurement.
- **H7:** A legacy run without frozen review metadata opens with its limitation and available artifacts. Migration creates no inferred approval, alternate player, selector or byte-sum implementation.
