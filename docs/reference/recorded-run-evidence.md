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

The accepted [Compare by AC](#compare-by-ac) amendment adds optional capture
bindings. Publication `covers` and before/after pairs are derived from those
bindings by the existing engine writer, never authored as another claim mapping.

An artifact package MUST belong to one execution attempt. Preflight and execution
MUST refuse an existing recipe package before replacing files or starting capture
or actions, including failed and partial attempts. A rerun uses a fresh artifact
directory and leaves prior package and publication-reference bytes unchanged.
Task wrappers allocate fresh attempts and return their actual directory. The
existing version-1 `latest-valid-recipe-run.json` selects a retained successful
attempt for task checks; publication still freezes that selection and its bytes.
`@farmslot/protocol/recipe` owns `LatestValidRecipeRunPointer` and its shared
`sanitizeLatestValidRecipeRunPointer` helper for gateway and task-check consumers.
Media selection references original attempt paths rather than overwriting copies.
The Node `@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs` helper owns
task selection IO for the CLI and wrappers. Its read/write exports use that
version-1 contract and are versioned with the runtime package; they grant no
publication admission.

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
`farmslot-agent ac` is read-only after cutover; local verdict writing is removed.
Only the Accepted [verified override contract](#verified-claim-overrides) grants
an untestable exception through a credential-backed gateway receipt. It never
changes the immutable engine ledger or manufactures a proven verdict.

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

**Timing rule:** Capture starts before the first proof node: a UI node or an
assertion node (`assert_output`, `assert_json`, `assert_file`, `ui.wait_for`),
including a node inside a called recipe. After binding, the engine waits
`EVIDENCE_PADDING_MS` before running that node, so the node clears the recorder's
start and has padded footage before it. Capture stops after the final HUD outcome.
Setup before the first proof node that proves nothing, such as an app restart or
state seeding, stays unrecorded (ADR-062 Amendment 14). Recorder readiness is
checked before setup; target resolution and admission bind the process running
at the first proof node. Explicit recording for a recipe without UI nodes starts
at run entry. Play
`[startRangeMs[0] - 1000, endRangeMs[1] + 1000]`, using one
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

Trusted host diagnostics, execution/product provenance, recovery metadata, observer
exports and human reports MUST finish before package validation. The engine is the
only writer of `summary.json` and `artifact-manifest.json`. Hosts register sidecar
entries and descriptive metadata through `RecipeRunRequest.finalizeArtifacts`,
using `RecipeArtifactFinalization` from `@farmslot/recipe-runner`. The named consumer
is the shared recipe-cli `run`/`call` host. Engine-owned status, counts, identity and
artifact fields cannot be replaced by host annotations. Existing provider observers
index a separate `observer-artifacts.json`; its entries join the canonical manifest
before validation. No closeout step rewrites the validated package. These optional
host bindings are experimental until the coordinated package release.

The existing `@farmslot/recipe-cli/harness` closeout exports keep their jobs:
`finishRunDiagnostics(baseline, context, classifier)`,
`writeExecutionProvenance(artifactsDir, snapshots, drift, context?)`,
`indexProductProvenanceArtifact(context, target, adapter, browser?)`,
`writeRunReport(context)` and `writeViolationReport(context)` register with that
same engine context. Standalone provenance failure records may omit the context;
they do not modify a retained package manifest. Consumers of the former path-based
signatures migrate in the coordinated breaking recipe-cli release. The `run`/`call`
commands and provider `RunObserver.finalize(path?)` interface keep their existing
arguments; the host supplies the observer sidecar path during closeout.

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
Unpinned completed media defaults to 30-day local retention, overridable by
storage policy. The accepted historical-review design retains lightweight frozen
review metadata for the run's history lifetime; media may expire once dependency
pins are released. Preserve an unavailable-media record without changing recorded
verdicts or ranges. Derivatives share the source media lifetime. This is the
approved end state; the historical/footprint implementation remains pending. Delete temporary staging on stop/
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

| API/signature                                                                                                                                    | Owner and consumers                                                                   | Status/replacement                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdapterRecording.target(context): Promise<RecordingTarget>`; `videoRecorder(): Promise<VideoRecorder>`                                          | `@farmslot/adapter-sdk`; engine and platform providers                                | Evolve existing contract; target resolution stays provider-owned                                                                              |
| `VideoRecorder.start(request): Promise<ActiveVideoRecording>`; `stop(): Promise<VideoRecordingResult>` returning ordered segments                | Executable backend contract in the SDK; runner/platform backends                      | Version changed result shape; keep one definition and built-in backends                                                                       |
| `createDefaultRecipeEngine(options: DefaultRecipeEngineOptions): RecipeEngine`                                                                   | Proposed `@farmslot/adapter-sdk`; CLI and custom harness composition                  | Existing public export is `@farmslot/recipe-cli/harness`; move only these engine factory/types in coordinated breaking release, no alias shim |
| `createEvidenceReviewModel(input: EvidenceReviewInput): EvidenceReviewModel`; `validateRecordedEvidencePackage(package): RecipeValidationResult` | Experimental `@farmslot/adapter-sdk/evidence`; web/native review contexts and gateway | Portable model/validator; methods own claim/step selection, caption, seek and bounded playback state                                          |
| `materializeEvidenceClip(package, moment, outputDir): Promise<ArtifactRef>`                                                                      | Proposed `@farmslot/recipe-runner`; artifact CLI/publication                          | Bounded on-demand derivative from validated references                                                                                        |
| `refreshPublishedEvidence(client, params): Promise<RunRefreshPublishedEvidenceResult>`                                                           | Proposed SDK client entry; authorized artifact CLI/integrations                       | Existing typed gateway RPC remains sole publication authority                                                                                 |

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
Before publication or refresh, the gateway MUST scan the selected frozen
manifest, recipe inputs, metadata and indexed non-media bytes with the existing
`@farmslot/handoff/scrub` secret detector. Scanned files MUST retain their frozen
digest identity. Scan incoming PR prose before an LLM request and rendered prose
before GitHub create/edit. A detected value MUST refuse publication using only
its kind and fingerprint, with a rerun/refresh action; never redact retained
bytes or waive the refusal through evidence attestation. Bare integrity and
transaction hashes remain allowed. This text scan makes no claim about secrets
in image or video pixels; existing media review remains required.

Never expose tokens/private traces. Removing duplicate `covers` requires the
ledger relationship to remain available to publication consumers.

## Migration and conformance

The task-ledger source cutover is tracked by [#1044](https://github.com/deeeed/farmslot/pull/1044),
pending review and merge. Package publication and adopter rollout remain separate.

The coordinated writer cutover follows engine conformance and consumer/adopter
migration. The engine is then the sole normal verdict writer; task copies are
selected-execution transport. Task writes and current completion MUST reject
schema 1; local normal verdict and override writing MUST be removed. Current
coverage MUST come from structured engine claims, never manifest `covers` or a
`recipe-coverage.md` fallback.

The one-time retained-data migration labels schema-1 ledgers as display only
through the shared model's limitation caption and existing pre-cutover run version.
It MUST preserve original ledger bytes and frozen inventory/decision identity.
Do not backfill `recordedEvidenceContractVersion`, convert schema 1 to a recipe
package, infer claim bindings or timestamps, or sign old override chains. Existing
retained links remain visible without deriving new manifest relationships. Convert verified relationships once through the [retained criterion-link migration](#retained-criterion-link-migration) and retain other historical media as explicitly untimed. Delete replaced external recorders, PID/signal/trap/
moov steps, manual linking, video-only promotion and private timestamp logic.
Specific adopter files and release coordination stay outside this public spec.

Named checks below are required before release; they specify proof, not existing
successful test results:

- **P1 timing/lifecycle:** Verify measured-range playback with the shared 1 s padding, capture before the first proof node, final HUD before stop, untimed/no-seek and outside-recording states on adjacent nodes and interruption. No invented timestamps or precision qualification.
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

### Review implementation interfaces

The experimental portable SDK model owns claim/occurrence projection, original
media identity, captions and playback effects. Renderer adapters use each file's
`artifactPath`; the model retains its package-relative `path` separately. Legacy
task-ledger paths already belong to the task transport namespace and remain
untimed. `loadRecordingEvidenceReview` loads only timeline/trace metadata for an
existing standalone player. It cannot promote a legacy file into a recorded claim.

The Node retained reader accepts optional trusted `RecordedEvidencePackageReadIO`
callbacks for one root's file inventory, contained JSON reads and actual-byte
hashes. Local and remote hosts share its input-closure logic and diagnostics.
The existing recipe-artifact RPC may return selected-package metadata on demand;
that display snapshot is not frozen approval authority. Gate consumers still
require the approved complete inventory and canonical validation.

Report review reuses `OutputReviewPayload` and `RunOutput` identity.
`readEvidenceReviewReport` refuses a changed snapshot or changed report bytes.
The existing document viewers render that checked text and the same case/check
controls used at the gate. Publication, visual-judgment persistence and resource
qualification remain separate completion gates for this feature.

## Accepted amendment: historical review, chapters and footprint

Status: Accepted, 2026-10-13. These requirements define the approved end state;
implementation remains pending. They add no capture clock or accuracy contract.

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

## Shared review curation and saved results

[ADR-062 review curation decision](../adr/062-recorded-run-evidence.md#shared-review-curation-and-saved-results)
owns the delivered finding-publication and retained-review presentation contract.
Its normative [review curation specification](review-curation-and-results.md)
defines reviewed-source reads, payload fingerprints, immutable accepted payloads,
selected finding publication and read-only saved results. Existing protocol
projections and native viewers are shared. This contract retains its own accepted
status and shipping PRs. The historical-review/footprint design in
[#967](https://github.com/deeeed/farmslot/pull/967) has separate acceptance and
pending implementation.

## Verified claim overrides

Status: Accepted, 2026-10-13, ADR-062 Amendment 4, #1015. These requirements add human override
authority without changing recipe packages or Amendment 3 publication approval.

### Selection and authority

Task-ledger projection MUST occur only when the successful-attempt pointer
advances. Failed or out-of-task attempts MUST preserve both pointer and projection.
A schema-2 projection MUST match the selected package's `recipeRunId`; a mismatch
is non-waivable `evidence-execution-mismatch`, before verdict comparison. Protocol
owns that typed `RunGatePrerequisiteReason` code; clients do not parse messages.
When publication also selects a baseline, the projection binds to the selected
passing implementation attempt. Baseline identity/policy remains separate.

Completion MUST allow a valid selected engine package with unresolved claim
verdicts to reach its existing ready/output-review gate. `missing`, `weak`,
`failed` and `awaiting-review` remain visible and blocking for approval; they
are not successful proof. Verify package integrity, execution/registration and
unrelated completion requirements before presenting it. This changes only the
pre-gate verdict refusal, not publish/release admission. No worker request marker,
`allowWeak` workaround or automatic untestable verdict is introduced.

`run.overrideClaim` MUST accept only a registered claim in a canonically validated
selected execution at an unresolved ready or output-review gate. Use that gate's
existing frozen inventory, decision/digest identity and reader, never mutable
latest files. Completed/cancelled/historical runs and non-gate calls are refused.
Missing registration, invalid package or a different execution is not untestable
evidence and MUST NOT be repaired by this operation.

Authorize an active credential-backed person with current global-admin authority,
using Amendment 3's trusted ingress rules. Recheck identity and the decision's
snapshot after awaits and before storage. Service, node, worker, background,
synthetic solo-mode and client-supplied actors MUST be refused.
A solo operator provisions an active person credential and global-admin role
through the existing authentication setup before using this operation.

The gateway derives `claimReviewGate` in the existing worker terminal contract
from the same human-gate/output-review policy used by execution. The completion
checker uses the public SDK reader and validator to bind the selected package,
and for a [QA case ledger](#qa-case-ledger) each row's case package, before
deferring verdict checks. The monitor calls that same checker. Flows with
no applicable human gate keep their completion refusal; projects expose no
verdict-waiver flag.

Role cleanup MUST preserve the entire initialized worker terminal contract,
including gateway review policy, run contract version and frozen deterministic
commands. Retained `run.replayStep` from monitor or later restores the original
dispatch contract after checking the task handoff's run/project/flow identity and
the contract's flow/mode/version. A current run with a missing, unreadable or
mismatched dispatch contract fails recovery. Replay does not infer policy from
skipped downstream steps or change retained registration, claims or package bytes.
This restoration applies to gateway-produced dispatch contracts. The existing
write-task output marks adoption of an authored `run create --task` task with
`skipped: true`; replay preserves that task's original identity, commands and
runtime metadata. It does not downgrade the Run's evidence contract version or
change gate evidence admission. A failed remote contract write MUST stop replay.

### Receipt and effective row

The existing Run store owns append-only `ClaimUntestableOverrideReceipt` records.
Each records receipt ID, run/decision/claim IDs, `recipeRunId`, checked closure
identity, prior verdict, trusted approver, nonblank reason and server time. Record
credential ID for audit only; never credential secrets. The closure identity is
the shared canonical digest of execution ID and sorted package-relative paths
with the actual byte digests consumed by the canonical reader. No new evidence
store, format or client-provided digest authority is introduced.

The engine package and task projection bytes MUST remain unchanged. Gateway review
projection derives the effective row from the engine claim and matching stored
receipts. Its verdict is `untestable`, with original verdict and ordered override
history visible. Unverified local `overrides` remain visible as unauthorised data,
MUST NOT grant admission, and MUST NOT be adopted into a verified chain.

One `isAuthorizedOverride(row, engineClaim, authority)` predicate MUST govern both
`satisfied` and `bound`. `authority` is the gateway's stored receipts and checked
execution/closure context, never request or task-file metadata. It requires:

- An untestable row and a nonempty chain whose every entry matches a stored receipt
  for this run, claim, execution and closure, with trusted actor, reason and time.
- The first prior verdict equals the immutable engine verdict; each later prior
  verdict is `untestable`. Repeated overrides cannot hide an unsigned entry.
- Registered claim identity/text matches the selected engine claim. Integrity,
  execution binding and every unrelated gate prerequisite still pass.

The predicate checks references; it does not authenticate callers. Clients consume
the gateway projection and MUST NOT treat a locally constructed receipt as trusted.
Untestable satisfies only the existing explicit-untestable policy, never proven or
visual confirmation. Publication attestation remains a different operation.

### Persistence and freshness

Persist the receipt before returning an effective override. If storage fails,
leave the gate unresolved with no effective change. After reauthentication, a
retry returns the same committed receipt for the same person/run/claim/execution/
closure/reason, even if refresh changed the decision identity. It writes nothing;
require current decision/snapshot freshness for every new receipt. A new reason
appends a new chain entry. No separate task-file write can succeed
while receipt persistence fails. Readers derive the row after restart.

The operation MUST NOT resolve or publish the gate. Receipt changes invalidate
cached policy evaluation and publication confirmation. Existing refresh rebuilds
the gate projection and package identity with the applied receipt IDs; policy and
final publication recheck the same receipt set. Output review re-presents its
unchanged captured inventory plus that projection. A changed closure or selection
cannot reuse an old receipt, even if claim labels match.

### Public surface and conformance

The experimental protocol exports `ClaimUntestableOverrideReceipt`,
`ClaimOverrideAuthority`, `isAuthorizedOverride`,
`recordedEvidenceClosureIdentity`, `projectClaimUntestableOverride` and
`runClaimOverrideSnapshotIdentity`. Gateway writer, gate policy and the SDK review
model are their consumers. The gateway supplies checked display authority on
`RunRecordedEvidenceReview`; clients do not load authority from task files.
Existing gate and output consumers share the pure `humanGateEnabled` and
`runOutputReviewEnabled` policy helpers.

`farmslot run gate <runId> --decision <id> --action mark-untestable --claim <id>
--recipe-run <id> --reason <text>` routes to `run.overrideClaim`, not decision
resolution. CLI and existing web/native gate renderers are the named consumers.
SDK gateway clients expose that same typed RPC. `RunOverrideClaimParams` includes
the displayed snapshot identity; actor, time and prior verdict are server-owned.

`@farmslot/protocol` owns request/receipt and Run projection types;
`@farmslot/protocol/recipe` owns the shared predicate and closure-identity helper.
They are additive, experimental contracts versioned with that package. Generate
CLI/API reference entries at implementation. Extend the existing shared action
model and renderers; there is no second override form, reducer or player. Providers
implement no override hook and inherit the gateway policy. After conformance,
remove schema-2 local `ac set` override writing; unverified chains are never
grandfathered. A task row with an unsigned chain blocks the operation until a
canonical engine projection replaces it; the gateway does not silently discard
or sign its history. Ship the pre-gate verdict transition and update task-contract,
runtime documentation and completion refusal guidance with this cutover. Guidance
MUST direct unresolved claims to human review, never local `ac set` or `allowWeak`.
Normal-writer cutover retains the existing migration rules.

- **O1:** Actual hosted recipe execution A passes and selects its ledger. Failed B
  and an unselected passing attempt preserve A's bytes. A different ledger
  `recipeRunId` blocks normal and attested publication.
- **O2:** A verified human can mark one selected registered claim untestable. The
  same receipt/original verdict appears in CLI, both clients and after restart;
  both satisfaction and binding accept the authorised chain under existing policy.
- **O3:** Repeated reasons preserve the chain; a lost-response retry is idempotent.
  Blank reason, unsigned/imported entry, wrong actor/execution/closure or a bad
  first/later prior verdict refuses. Storage failure changes no effective row.
- **O4:** Revoked/service/worker/solo identity, stale/resolved decision and corrupt
  evidence refuse. An override resolves no gate, grants no publication, changes no
  evidence bytes and cannot survive selection changes or bypass unrelated failures.
- **O5:** A successful selected recipe with a registered untestable/missing claim,
  and a separate visual claim awaiting review, reaches the existing human gate
  through ordinary worker completion. Approval remains blocked. A verified human
  marks only the untestable claim; pending visual review and unrelated requirements
  still block. Invalid integrity/identity refuses before presentation. The worker
  writes no verdict or override marker; no `allowWeak` option is used.

## Evidence gate policy

Status: Accepted, 2026-10-13, ADR-062 Amendment 3. These requirements change publication policy, not recording
contracts or artifact-only output-review authority.

### Integrity and policy findings

The gateway MUST first load and validate selected recorded input closures using
the canonical reader and validator. Non-recipe files retain the existing frozen
publication inventory/identity checks; they do not require recipe metadata. Unreadable/missing inputs, invalid structure,
digest mismatch, replaced bytes and tampering MUST block every publish action.
Legacy display access MUST NOT become machine-validated evidence.

The same evaluator MUST expose typed policy findings separately: disallowed claim
verdict, criterion text binding, expected-baseline applicability, or non-recipe
criterion binding. Clients MUST consume this shared classification rather than
parse messages. Unknown failures are non-bypassable. Code review, CI, source,
publication selection and other gate prerequisites retain their existing policy.

### Human attested approval

`approve-publish-evidence-attested` MUST be offered only for an unresolved human
publish gate with valid integrity and at least one eligible policy finding.
The existing gate UI MUST show the findings and require a reason before its
explicit confirmation; the CLI MUST require `--reason <text>` for this action.
Empty/whitespace-only reasons MUST be refused.

The gateway MUST resolve current person identity, active credential and the
existing global-admin authority for `run.resolveDecision` from trusted ingress context, then recheck them at consumption.
Service/node identities, automatic resolution, direct background calls and the
synthetic solo-mode person MUST be refused even with a reason. Client kind,
client-supplied actor and runner name confer no human authority. Operator
credentials MUST NOT be delegated to workers or lanes.

Before publication, persist the reason, trusted approver identity, time, run and
decision IDs, frozen package/manifest identity, selected evidence and waived
typed policy findings in the existing decision/run provenance. The persisted
receipt MUST render in the PR body through the normal publication pipeline and
remain visible through refresh. Never copy credential secrets into the receipt.

Consumption MUST revalidate the decision and exact package after awaits; a
refresh, selection or input change invalidates the attestation. Refusal leaves
the gate unresolved. Attestation MUST NOT rewrite trace, claims, task ledger,
media or machine readiness into successful proof. It waives only the recorded
policy findings; integrity and unrelated prerequisites still block.

### Normal applicability and binding

1. **Expected baseline.** A task-declared baseline binds an exact selected
   execution and qualified assertion occurrence to an expected failure. It
   satisfies that baseline expectation only when the trace fails at that
   occurrence, with no unexpected earlier/additional failure or interrupted
   capture. A directory name or failing summary alone is insufficient. Preserve
   the failed summary and missing later claims; a separate passing execution
   must satisfy the implementation's positive claims. Freeze the declaration
   with the existing gate evidence inputs, not in a new evidence store.
2. **Retained inspection, pre-cutover only.** This rule applies only to runs
   without a gateway-stamped `recordedEvidenceContractVersion`. A schema-v1 task ledger's inspected `proven` row may
   satisfy a schema-v2 visual/mixed claim's `awaiting-review` policy only when
   registered ID/text and cited evidence bind to the same selected execution's
   frozen closure. No evidence or a different attempt cannot bridge the verdict.
   Keep the original schema-v2 verdict and the legacy review source visible;
   this migration rule does not restore a second normal verdict writer.
3. **Criterion text.** Match registered IDs using the shared claim-ID normalizer.
   Trim/collapse whitespace and remove only a leading `AC<n>:` label whose ID
   matches that criterion. The remaining text MUST match exactly. Do not ignore
   changed meaning, a different AC label or mismatched IDs.
4. **Non-recipe proof, pre-cutover only.** For an unversioned retained run,
   task-declared unit/revert-test evidence may satisfy its
   applicable state criterion through its retained successful result and checked
   citations. Do not require a fabricated recipe claim. Missing/failed results,
   uncited files or unit-only evidence for a visual criterion remain unsatisfied.

### Public surface and conformance

Protocol owns the additive action descriptor, reason input and attestation
receipt on the existing `RunResolveDecisionParams`/decision contracts. Existing
CLI and SDK/gateway transports consume the same typed `run.resolveDecision`
boundary; it always requires human authority. `farmslot run gate <runId>
--action approve-publish-evidence-attested --reason <text>` is the sole new CLI
use. Generate its CLI reference and document the reason/receipt contract with
the implementation. Shared web/native action projections and existing gate
renderers present identical findings; no second policy mapper or gate component.
Contracts version with `@farmslot/protocol`; no recording-schema bump, new
provider extension or agent evidence instructions are required.

- **G1:** A credential-backed publish-authorized person can attest a valid frozen
  package with policy mismatches. The same reason/actor/package receipt appears
  in the retained decision, PR body and refreshed body.
- **G2:** Blank reason, service/node/background/solo caller, revoked credential,
  stale decision or changed package refuses without publication or resolution.
- **G3:** Missing input, invalid structure, wrong digest or tampering refuses even
  with valid human identity/reason. Unrelated review/CI/source refusal persists.
- **G4:** The exact expected baseline failure satisfies only its declaration;
  wrong-step failure, unexpected pass, additional failure and interruption do not.
- **G5:** The four normal rules admit bound baseline, inspected pending visual,
  matching AC-label and declared test evidence without attestation. Their
  wrong-attempt/text/ID/result counterparts remain blocked; original artifacts
  and verdicts stay byte-for-byte unchanged.
- **G6:** CLI and both gate contexts use the shared descriptor and gateway
  classification. Artifact-only output review and legacy read-only viewing keep
  their existing authority; neither grants publication.

## Selected evidence run contract

The gateway MUST stamp `Run.recordedEvidenceContractVersion` with
`RECORDED_EVIDENCE_RUN_CONTRACT_VERSION`, currently `1`, at creation. Clients and
workers MUST NOT choose it. Absence identifies pre-cutover stored runs; load,
replay and artifact refresh MUST NOT backfill it. Unsupported versions fail
closed with `evidence-contract-unsupported`.

The engine MUST write an attempt-local `evidence-manifest.json` using the existing
publication format, derived from registered artifacts and claim verdicts before
final artifact-manifest validation. This is a publication candidate, not another
claim writer. Projects declare recipes and MUST NOT copy or rewrite that file.

For version 1, publication and its gate MUST read only the frozen selected
execution. Freeze its pointer or exact engine manifest source and every input
consumed by the canonical reader. A headless attempt freezes the same closure
without inventing or selecting media. An explicitly empty media selection MUST
NOT publish historical captures. Refresh and consumption recheck the closure
even when no media is uploaded. A missing, malformed or changed selection MUST
NOT fall back to the task-root ledger, inherited selection or another attempt.

`RunRecordedEvidenceReview.contractVersion` projects `0` for unversioned retained
runs and otherwise preserves the stored version. Its typed `failureCode` uses
`evidence-selection-missing`, `evidence-selection-invalid`,
`evidence-package-unverifiable` or `evidence-contract-unsupported`. These display
codes grant no waiver; existing integrity and gate policy still apply.

The gateway MUST project the same version into the existing worker terminal
contract. Pre-cutover contracts retain their declaration-based publication
selection. Version 1 requires the engine candidate. A missing candidate from an
older runtime requires updating that runtime before retrying.

QA completion MUST locate its registered smoke execution through
`qa-result.json.packages[smoke.caseId]`, including nested destinations. This
placement check grants no QA admission; the existing finalization and gate checks
still verify the whole frozen suite. Explicit CLI artifact destinations keep
their requested layout. Managed task execution without a destination allocates a
fresh attempt; the builtin wrapper also allocates one for its legacy destination.

The SDK model MUST default to the current contract for standalone callers. Legacy
requires explicit pre-cutover context and absence of a recognized current
package. Newer unverifiable packages are Invalid, with a recovery action, and
cannot provide measured proof. Both renderers pass the gateway projection through
the shared model. Retention and report opening remain read-only and do not
require successful publication selection.

Public consumers use `farmslot recipe run` and `farmslot recipe artifacts`, the
existing runner/writer exports, protocol contracts and
`createEvidenceReviewModel`. The contract adds no execution flag or alternative
reader. Remove project selection writers only after their consumers use the
engine candidate. Task-root declarations MAY supply comparison labels, pairs,
omissions and non-recipe media. The shared resolver MUST reject a declared recipe
artifact owned by another retained attempt, using artifact-manifest membership.
It MUST freeze every contributing declaration's bytes alongside the engine
manifest and selected pointer. It MUST preserve true-before external captures
and existing presentation fields without inferring comparisons from filenames.

Conformance MUST verify new-run stamping without historical backfill, unsupported
version refusal, automatic manifests for UI and headless recipes, rejection of a
second producer, selected-only reads despite corrupt unrelated packages, immutable
headless consumption, no fallback after missing/corrupt selection, and identical
Legacy/Invalid status in both clients. A minimal author supplies only a recipe;
the publish gate receives the complete engine evidence package.

## Authenticated visual review

The gateway MUST authenticate a credential-backed person with the existing human
evidence-review authority. It MUST record a visual judgment in the existing Run
store, bound to the run, selected `recipeRunId`, checked input closure and exact
engine-derived moments. The gateway supplies actor, receipt ID and time. A worker
note, task verdict or client actor string grants no visual authority.

The writer MUST use the canonical reader and validator against the frozen ready
package or captured output inventory. QA selection comes from its captured
canonical case index; unregistered history cannot become a selected case. Missing,
changed or invalid bytes refuse the write. A retained completed or cancelled run
MAY receive a judgment for its selected captured evidence; this MUST NOT reopen
the run, resolve a gate, register another package or approve publication.

The existing engine reducer MUST consume the authenticated judgment. Confirmation
can prove an eligible visual/mixed expectation whose assertions passed; rejection
fails it. A judgment cannot repair an assertion failure, missing proof or invalid
package. Parent outcomes derive from their checks. Retained trace, media, manifests
and claim/task files MUST remain byte-identical. The shared SDK model supplies
the effective review verdict to both clients; no second verdict reducer is allowed.

Writes MUST recheck person and snapshot identity after reads and before persistence.
Retries MUST reuse an already recorded identical judgment. The last matching Run
receipt determines the current visual review, using stored order rather than
clock precision. Gates MUST freeze the receipt IDs they reviewed; changed judgments
require a refreshed publication package. Output review updates its human receipt
references without changing captured artifact/report identity. Historical snapshots
retain their captured references. Recording a judgment grants no gate approval.

QA task binding MUST require schema-2 engine claims with the selected execution ID,
or for a multi-case QA task each row's case execution ([QA case ledger](#qa-case-ledger)),
matching registered IDs/text and engine-derived verdicts or authorized untestable
exceptions. Remove schema-1 file-reference binding without a compatibility writer.
An output-review gate preserves eligible visual claims as awaiting review until a
person judges them; execution completion does not confirm their visual meaning.

Public human commands use `farmslot run gate <run> --action confirm-visual|reject-visual
--claim <id> --recipe-run <execution>`. Under Amendment 9, `--reason <text>` is
required for rejection and either delegated verdict; person confirmation omits it. The existing CLI owns this
human gate operation; recipe execution and artifact commands keep their single
family. Its reader uses the existing `RunRpc.recipeRunsForRun` execution selector
`recordedRecipeRunId` against captured registration, without requiring a display
artifact group. `RunRpc.reviewVisualClaim` and its request/receipt types belong to
`@farmslot/protocol`. Runner derivation and the portable SDK projection serve the
gateway, CLI and shared review model through
`deriveReviewedRecipeClaims(input, authority?) -> RecipeClaimEvidence[]`, exported
by `@farmslot/recipe-runner/evidence` and `@farmslot/adapter-sdk/evidence`.
`RecipeVisualJudgmentReceipt` and `RecipeVisualReviewAuthority` belong to protocol;
the gateway loads that authority from its Run store. These additive APIs are experimental and
ship in a coordinated minor release; providers inherit them without review code.
Generate CLI/API reference entries from their owning command definitions.

Conformance MUST cover state-only schema-2 QA, pending visual output, confirmed and
rejected visual claims, parent derivation, service/actor spoofing refusal, changed
execution/moments/bytes, stale snapshot/person races, restart and lost-response
retry, retained cancelled evidence, and unchanged package bytes. A real public
CLI/RPC control MUST record a judgment and show its derived verdict at the gate.

## Delegated visual judgments

**Status:** Accepted under [ADR-062 Amendment 7](../adr/062-recorded-run-evidence.md#amendment-7-2026-10-14-delegated-visual-judgments-and-compare-by-ac). Implementation is pending; implement this part first.

The existing gateway visual-review writer MUST support `person-reviewed` and
`lead-agent-reviewed`. This extends the preceding person-only requirement for
the delegated kind. Person review retains its credential-backed person check.
Agent review MUST use the reviewer's own active service principal/credential,
with existing RPC permission and explicit authorization by the run project's
operator-owned `visualClaimReview` policy. Node identities, anonymous
sessions and client actor strings grant neither kind. No agent may use a person's
credential or be recorded as a person reviewer.

`ProjectVisualClaimReviewPolicy` contains `delegatedReviewerPrincipalIds`,
`delegatorPrincipalId` and an optional `delegatorPrincipalGeneration`. A bare
delegator id binds identity generation zero; the pin names a later generation
(ADR-051 Amendment 5 clarification). Without an explicit
delegation, agent review is refused. The delegator is an identified person; the
reviewer must be listed for this project. Policy comes from
the existing trusted project configuration, never from task/recipe input or a
review RPC. The gateway rechecks policy and identity before persisting. It retains
the checked policy digest with the receipt; changed policy holds current gates
for refresh while historical review keeps its frozen policy/receipt references.

The project JSON key is `visual_claim_review`; the gateway projects it to
`ProjectConfig.visualClaimReview`. Managed packs use the existing operator
`SourceRuntimeSettings` value through `readSourceRuntimeSettings` and
`writeSourceRuntimeSettings` in `@farmslot/slot-config`. Pack bytes stay unchanged;
a pack-embedded delegation grants no authority. Unmanaged projects use their
operator-owned project JSON. The allowlist names the permitted service reviewer;
the existing RPC also requires admin authority. This policy does not grant that
role or change independent publication review. The visual-review operation adds
no dispatcher/producer separation rule; keep delegate credentials out of worker
inputs.

Extend `RecipeVisualJudgmentReceipt` with the kind and gateway-stamped reviewer
subject kind, delegation identity and policy digest. Both kinds retain the run,
selected `recipeRunId`, claim, exact moments, closure identity, verdict and time.
Under Amendment 9, a rationale is required for delegated judgments and all
rejections; authenticated person confirmation may omit it. The receipt MUST list the reviewed claim's visual files and their
checked digests, derived from the canonical input rather than supplied hashes.
The existing Run store remains the sole writer. Existing authenticated person
receipts retain their provenance and meaning; no package or task ledger is rewritten.

The canonical engine reducer MUST qualify the receipt against this authority.
`confirmed` may prove the visual part of an eligible visual/mixed claim whose
assertions passed; `rejected` fails it. Missing assertions, invalid evidence or a
different execution cannot be repaired by delegation. All other run gates and
the existing own/independent review, CI and publication rules remain in force.
An agent receipt grants no publish, close-run or policy-attestation permission.

The shared model, gate and PR body MUST display proof kind `assertion`,
`agent-reviewed` or `person-reviewed`, including the reviewer and recorded
execution/head identity. Agent review is labeled
`agent-reviewed (delegated by <delegator displayName>)`, never human-reviewed.
For mixed claims, show the assertion and review contributions without changing
the existing `state`/`visual`/`mixed` proof mode. A later valid receipt and retries
follow the same stored-order and submission-snapshot rules as person review.
`agent-reviewed` is the display projection of `lead-agent-reviewed`.

### Public surface and first implementation

| Entry                                                                                                                                                                | Owner and named consumer                                                                        | Change                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RecipeVisualJudgmentKind`, extended `RecipeVisualJudgmentReceipt` and `ProjectVisualClaimReviewPolicy`/`ProjectConfig.visualClaimReview`                            | `@farmslot/protocol`; gateway, installed project config and both clients                        | One receipt contract; explicit project delegation                                              |
| Existing `RunRpc.reviewVisualClaim` optional `kind`; `farmslot run gate --action confirm-visual\|reject-visual --judgment-kind person-reviewed\|lead-agent-reviewed` | Gateway/CLI; authenticated person and delegated lead reviewer                                   | Omitted kind selects person review; identity, files/digests and delegator remain gateway-owned |
| Existing `deriveReviewedRecipeClaims`, `RecipeVisualReviewAuthority` and `createEvidenceReviewModel`                                                                 | Runner and `@farmslot/adapter-sdk/evidence`; gateway, Command Center, Companion and PR renderer | Same reducer; qualified review kind/label, no new writer or review model                       |

These contracts are experimental and ship through coordinated package versioning.
Required incompatible type changes use the existing breaking-release rule.
Update the generated API/CLI reference and project-policy guide. Conformance MUST
cover authorized own-agent review, absent/foreign-project delegation,
actor/person impersonation refusal, evidence mutation,
policy change, retry/restart, visible proof labels and unchanged publication gates.
Prove this writer through public CLI/RPC and the shared gate before starting the
comparison implementation. It MUST work with selected retained evidence without
requiring new captures or a comparison pair.

## Compare by AC

**Status:** Accepted under the same Amendment 7. Implementation is pending; implement after delegated visual judgments.

### Capture binding and source

A screenshot or video capture node MAY declare `ac` and `role`. `ac` MUST resolve
through the existing claim registry and composition bindings to one AC, QA case
or QA check. `role` is `before`, `after` or `review`. The engine MUST record this
binding on the existing `RecipeArtifactManifestEntry`, along with the original
artifact identity, execution ID, producing occurrence and any existing
`EvidenceMomentRef`. This declaration annotates media; it MUST NOT make a capture
proof-eligible or change the engine verdict.

The engine MUST record the observed source commit as `sourceCommit` with the
capture, using the existing source/checkout authority. Worker-supplied SHA strings
are not observations. Trusted SDK hosts may supply that frozen identity as `RecipeRunRequest.comparisonSnapshot`; authored parameters cannot replace it. Without a frozen snapshot, the writer keeps standalone captures and their source limitation. The existing frozen `ReviewDiffSnapshot.baseSha` and
`headSha` define the compared revisions, not a later branch tip or recomputed
merge-base. Check `before`/`after` against that snapshot during finalization and
review projection. A changed snapshot yields a typed source mismatch and requires
refresh/reselection; it MUST NOT silently relabel the capture. Tracked-file changes,
including tracked fixtures, make the source dirty under the existing checksum
rules. Ignored generated fixtures outside that input set do not alone disqualify
a capture. `review` retains observed source
without claiming either side.
Unknown source remains visible with its limitation and MUST NOT be compared as
Before/After. Capture and selected review MUST agree on claim identity and text;
an unknown claim, invalid role or contradictory source binding fails validation.

If either or both optional declarations are absent, media MUST appear under
"Unassigned"; the omission itself is not a validation failure. Do not
infer either from filenames, prose, directory names, capture order or identical
bytes. Preserve the existing reader's Valid/Legacy/Invalid classification;
Unassigned describes comparison availability, not package validity. Recorded
stills use their existing occurrence/moment relation. A still with no measured
moment remains viewable; its video link MUST state untimed or outside recording
and MUST NOT invent a seek range. Existing padding and segment rules apply.

### Frozen selection and publication

A resolved captured view MUST retain the stored receipt's recorded policy qualification. It is read-only. Active gate qualification MUST use the current project policy; changing policy cannot grant a historical view publication authority.

The selected head execution remains the claim/verdict authority. Baseline and
review captures from another execution MUST be explicit comparison dependencies
of that selected evidence, using the existing manifest and closure reader. Freeze
their binding, observed source, original package metadata and media digests in the
same publication/output inventory. A failed baseline execution can illustrate
the defect if its package passes integrity validation; its verdict cannot satisfy
a selected head claim. Missing or changed dependencies refuse comparison and
publication of those files, while retained history stays readable. No mutable
latest lookup, borrowed task ledger or new package-selection path is allowed.

The hosted recipe path accepts the existing `--param evidenceBaseline=<relative
package directory>`; the public SDK supplies the same dependency through
`RecipeRunRequest.comparisonDependencies`. The host resolves it inside the
existing authorized task/project artifact root and the canonical reader validates
its original package. Record its `recipeRunId` and checked closure identity in the
retained invocation and selected artifact manifest's `comparisonDependencies`.
Reject a wrong source/claim binding, missing root or dependency cycle.

Before sealing the fresh selected package, the engine writer retains each unique
dependency once under `comparison-dependencies/<recipeRunId>/`, preserving all
original package bytes and execution/moment identities. This is an immutable
dependency copy in the existing artifact store, not another execution or writer.
Do not rewrite the original or register its captures as head occurrences. The
canonical reader loads and validates each declared root independently and freezes
its full closure; it does not validate baseline timelines against the head trace.
Existing size limits/footprint accounting include these retained bytes.

Existing publication pair/standalone paths stay relative to the selected root,
for example `comparison-dependencies/<recipeRunId>/stills/base.png`. Their capture
binding retains the original execution/path identity; the shared model selects
that source's existing moment. No escaping path or new external-reference parser
is required. `before_after_pairs.covers` describes the current registered claim,
while the baseline package's verdict remains separate.

The existing engine writer MUST derive `before_after_pairs.covers` and standalone
`covers` from the capture bindings. PR evidence and both clients MUST consume the
same result. Missing sides are shown explicitly. Multiple captures in one role
stay available; do not silently overwrite or pair them by filename. When several
pairs are possible, require explicit media selection through the existing review
selection/curation authority. Identical bytes with different roles or executions
remain distinct references. Rendering or selecting a pair grants no visual
judgment, gate approval or publication permission.

### Shared comparison view

The existing `createEvidenceReviewModel` MUST project one comparison row per
registered claim, retaining its text and canonical verdict. Rows contain Before,
After and Review media, their source revisions, the existing video moments and
explicit missing/unavailable states. Keep a separate Unassigned list; an AC with
no captures still has a row. QA cases/checks use these same rows.

Extend the existing Command Center evidence preview/lightbox and Companion media
viewer with this comparison context. Reuse them in the Evidence tab, gate review,
run detail, PR preview and ArtifactViewer. A two-image pair shares one normalized
zoom and focal position through the shared model, so either image's interaction
moves both without stretching their aspect ratios. Reset on pair change or model
rebuild/input refresh. On narrow displays the pair may stack; keep the same
selected pair and controls.
Load only selected media. Rendering per platform is allowed; duplicate grouping,
pair selection, transform state or verdict logic is not.

At a gate, show one screen with each AC's text, verdict and proof kind. When both
sides exist, show the matched before/after pair and source SHAs so the change
relevant to that AC is visible; otherwise show the AC's available visual proof
with the missing side stated. Unrelated captures MUST NOT fill a missing side.
The same factory exposes optional `gateSnapshot` facts from the existing `gateDecision`: recorded head, reviews, CI, prerequisite reasons and the existing next action. It grants no approval authority.

Each capture opens its own measured
video timestamp in one interaction. Untimed evidence keeps its explicit no-seek
state. On this same screen show own and independent review verdicts with the
reviewed head SHA, CI for that head, outstanding requirements and one primary
next action. Reuse the existing shared readiness/action and review-publication
models; do not derive approval from media or invent another gate resolver.

### Public surface and migration

| Entry                                                                                                                                                               | Owner and named consumer                                                             | Contract                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Existing capture-node `ac`/`role`; `RecipeEvidenceRole`, `RecipeEvidenceCaptureBinding`, extended `RecipeArtifactManifestEntry`/`ArtifactRef`                       | `@farmslot/protocol`; engine, gateway and capture providers                          | Optional annotations plus engine-observed `sourceCommit`; existing claim/moment IDs                         |
| `farmslot recipe run`, existing `--param` and `--artifacts-dir`; `farmslot recipe artifacts <directory> --format text\|markdown` and `artifacts validate`           | Existing recipe CLI; recipe authors and retained-evidence readers                    | Runs declared captures and exposes retained bindings; no comparison command or new flag                     |
| Existing `--param evidenceBaseline`; `RecipeRunRequest.comparisonDependencies` and `RecipeArtifactManifestDocument.comparisonDependencies`                          | CLI/runner and `@farmslot/protocol`; worker template, canonical reader and SDK hosts | Explicit baseline root, original execution and closure digest; independently validated contained dependency |
| Existing engine artifact writer and `RecipeRunRequest.finalizeArtifacts`; existing publication pair/standalone paths                                                | `@farmslot/recipe-runner`; hosted CLI, gateway and PR renderer                       | Sole producer; retains immutable dependency bytes within the selected root before sealing                   |
| `EvidenceReviewModel.comparisons`/`unassigned`, `EvidenceReviewComparisonRow` and shared comparison selection/transform methods through `createEvidenceReviewModel` | `@farmslot/adapter-sdk/evidence`; Command Center and Companion                       | One portable grouping, selection and normalized-image state; no additional model factory                    |

These additive fields/exports are experimental and require a coordinated minor
package release after conformance. Retained packages are not rewritten or
backfilled. Update recipe guide/examples and generate CLI/API reference entries
from their owners. Harnesses implement capture/target actions and supply observed
source through the existing host; they inherit binding validation, moment
navigation and publication. Worker templates request a base-checkout capture and
a head-checkout capture through the same public recipe path, preserving held
workspaces. Move consumers before removing filename/purpose classifiers,
independent pair maps and handwritten publication bindings they replace.

Replace these current role/pair rules after their callers consume the shared
projection. Source locations identify the design baseline, not a second contract.

| Existing rule                                                                                | Replacement                                                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/recipe-runner/src/node/writers.ts:113`                                             | Full-run/standalone publication roles derive from retained capture bindings        |
| `apps/command-center/ui/src/components/workspace/workspace-artifacts.ts:65`                  | Explicit role groups and Unassigned from the SDK model                             |
| `apps/command-center/ui/src/utils/artifact-pairs.ts:57`, `:85`                               | Claim-bound candidates and explicit selection; remove filename AC/pair guesses     |
| `apps/companion/src/lib/family-evidence.ts:69`, `apps/companion/src/lib/artifact-url.ts:366` | Same role/pair projection as Command Center; retain Diff, Recipe and Setup filters |

The existing Lit lightbox and native `MediaViewer` remain the rendering owners;
extend their controls rather than adding comparison viewers.

### Conformance

Verify canonical AC and QA bindings; base/head source mismatch and dirty-source
refusal; Unassigned captures; empty and one-sided rows; repeated captures and
equal-byte references; parent/composed IDs; independent failed baseline verdicts;
frozen dependency mutation refusal; untimed/outside-recording links; identical
PR/client grouping and zoom reset. A real ticket run MUST retain a base/head pair
for every applicable AC through the public recipe path and show it in Command
Center and Companion. Negative controls MUST fail on the wrong AC or revision.
That live acceptance follows implementation; this amendment does not claim it.
The real ticket gate demo MUST show the complete one-screen review, including a
matched pair or honest single-proof fallback for each AC, timestamp navigation,
agent/person review labels, head-bound independent review and CI, open requirements
and the correct single next action. No tab-hunting or inferred screenshot binding.

## Retained criterion-link migration

Status: Proposed under ADR-062 Amendment 8. Implementation and rollout in #1044
remain pending.

This finite migration preserves existing display relationships before the normal
manifest-cover reader is removed. Eligibility MUST come from an explicit,
operator-reviewed frozen task inventory. Missing Run records, filenames and dates
MUST NOT establish age or a run contract version. Do not add or backfill a Run.

### Storage and identity

The gateway stores one version-1 snapshot at
`.runs/retained-acceptance-links/<task-identity-sha256>.json`, under its existing
configured Run persistence root. It MUST NOT change a task artifact, ledger,
recipe package, publication manifest, frozen inventory or decision. The storage
subdirectory MUST NOT be loaded as Run records. Use the existing atomic JSON writer
with private file permissions.

This import covers gateway-local retained task roots. A snapshot's `taskDir` is
the exact normalized absolute task directory. Its filename hashes that UTF-8
identity with SHA256. Remote slot paths and relocated task copies do not inherit
it. No alias search or automatic identity repair is allowed.

The snapshot contains only `schemaVersion: 1`, `taskDir`, provenance
`source: {commit, helperSha256, inventorySha256}`, `handoffSha256`,
`manifestSha256`, registered `criteria`, existing `links: AcceptanceEvidenceLink[]`
and `refs: {path, sha256}[]`. Provenance identifies the frozen relationship reader
and the exact imported inventory bytes. It MUST contain no verdict, proof mode,
run version, timestamp, marker, moment or invented criterion binding.

### Import and refusal

The gateway maintenance script
`services/gateway/scripts/migrate-retained-acceptance-links.ts` takes a verified
inventory JSON file and the original local task-root directory. Use the workspace
`tsx` runtime. The inventory names `frozenSource`, `helperSha256` and `records`;
each record contains a task-root-relative `task`, `handoffSha256`,
`manifestSha256`, retained `links` and `refs` with `path`, `sha256`, `contained`
and `present`. Source identity MUST match the frozen released reader used for this
cutover, commit `5d57e6675a3f86ebc21ae9a41072b61fb958e418` and helper digest
`93b9b04c76a37fff11b8ce0e6e5026cd9c111618f310ff6f1a41c9219b633b43`.
This script imports relationships already reviewed in that inventory. It MUST NOT
parse `covers`, derive relationships from file extensions or scan for new tasks.

Before persisting any record, verify the whole inventory and every original byte
digest. Register criterion IDs from the checked handoff and reject unknown or
duplicate IDs, missing or extra references, noncanonical paths, task/asset symlink
escapes, missing files, digest mismatches and any existing task ledger. Paths MUST
remain canonical task-relative `artifacts/…` paths. The file-reference set MUST
exactly match the retained links. Check each manifest as bytes without parsing it.

Retries with an identical snapshot MUST leave its bytes unchanged. A different
snapshot at the same storage identity MUST refuse replacement. Validation failure
MUST write no snapshot. Persistence failure MUST surface an error; an identical
retry may finish an interrupted import. Preserve original media and metadata bytes.

### Reads, authority and public surface

The existing gateway acceptance display reader MUST prefer any task ledger. When
there is no ledger, it may read only the snapshot for that exact local task
identity. It MUST validate the snapshot and check the original handoff, manifest
and linked-file digests and containment before returning its existing DTO links.
It MUST NOT interpret manifest contents. No snapshot means no historical link
fallback and no manifest read. Missing, invalid or changed retained data produces
`acceptanceEvidenceLinksError`, separate from the ledger's
`acceptanceStatusError`. Normal completion and gate checks MUST NOT read snapshots.

Both clients consume the existing `TaskProgressResult` fields and shared
experimental `@farmslot/adapter-sdk/evidence` input. Links remain visible as
unassessed, untimed files. They establish no criterion verdict or recording
availability and grant no approval, publication or completion authority. Artifact
transport and players remain unchanged. This is an operator import, not a new
public CLI family, SDK export, RPC or provider contract.

Conformance MUST show an identical retry, failure before writes, changed-byte and
identity refusal, unknown criterion/path refusal, separate error captions, ledger
precedence, no parsing for uninventoried tasks and unchanged original bytes. The
retained inventory's relationships MUST survive through the actual display reader,
`task.progress` and shared model without fabricated status or timeline fields.

## Per-criterion confirmation

**Status:** Accepted under ADR-062 Amendment 9 on 2026-10-16. Amendment 11 below supersedes its pipeline policy, manual refresh and approval audit rules. Enable after coordinated reader and writer deployment.

Clients MUST show a qualified delegated receipt's visual verdict, written rationale
and bound still/moment as the recorded pre-validation. Engine assertions MUST be
labeled checks, never visual pre-validation. Task-ledger/worker notes MUST NOT
substitute. Absent visual review MUST show "Not recorded". A permitted qualified
delegated receipt already satisfies its AC under Amendment 7; another person
confirmation is optional. Amendment 11 removes all person-only restrictions.

The existing authenticated visual writer MUST accept `person-reviewed` +
`confirmed` without `reason`. Both clients MUST offer "Looks right" in one tap.
"Issue" MUST open a reason field and submit `rejected`; blank rejection reasons
MUST be refused by the gateway. Delegated judgments of both verdicts MUST retain
reasons, and raw recipe-package/ledger judgments MUST retain their existing
rationale requirement. No fabricated default text is permitted.

The protocol receipt qualifier, runner's claim/package validator and existing
reducer, gateway writer, SDK, CLI and both clients MUST agree. Historical receipts
and packages MUST retain their original bytes. Reviewer, snapshot, execution,
closure and exact-file/moment qualification MUST remain enforced.

Normal approval after required ACs are satisfied MUST NOT request another
evidence-attestation reason. The existing authenticated per-AC reviewers, frozen
receipt IDs and PR provenance are its audit; normal publication authority MUST
remain unchanged. No separate normal-publish approver receipt is introduced.
A changed judgment MUST still block approval until the existing package refresh;
clients show "Refresh package". Unjudged/rejected claims cannot be confirmed by
approval. Source/CI/reviews/integrity still apply. A separately offered policy
waiver retains its explicit reason and scope.

Conformance MUST cover person confirmation without prose, blank rejection and
blank delegated judgment refusal, raw reasonless embedded judgment refusal,
recorded/missing pre-validation, unchanged delegated qualification,
identity/snapshot/selection refusals, refreshed receipt binding and
normal approval without redundant text. All gate actions MUST provide at least
44-pixel touch targets and MUST NOT depend on hover.

Public surfaces and coordinated release are specified in ADR-062 Amendment 9.

Amendment 9 implementation exports `validVisualJudgmentReason` from
`@farmslot/protocol` for the gateway, receipt qualifier, runner, SDK, CLI and
both clients. An undefined kind denotes unqualified embedded input and always
requires rationale. The SDK's judgment row owns `pending`;
`visualPrevalidationLabel` in `@farmslot/review-dispatch` supplies the label to
both clients. These additive exports share the existing package versioning.
Implementation: [#1179](https://github.com/deeeed/farmslot/pull/1179).

## Independent visual verification

ADR-062 Amendment 11 governs pipeline visual judgments. Native review roles consume the protocol-owned typed result schema, retaining the command identity and execution closure. A worker's overall PASS or task-directory feedback never qualifies a visual claim. Pipeline review transport is native even when the retained producing worker uses tmux. Missing capability or result leaves the claim unchecked, without resetting a review budget.

Qualified per-AC results use the canonical visual writer, bound to recording, closure, file digests, engine moments and reviewer binding. A stable reviewer/closure/claim retry key prevents duplicate stamps and refresh loops. Public manual review RPCs cannot produce pipeline receipts. Every visual AC accepts a qualified pipeline receipt without project configuration. Person-only policy does not exist. A person may choose Looks right or Issue on any visual AC. A person's latest judgment outranks agent receipts within the same execution and closure; later agent results cannot clear a person's Issue.

Every newly recorded judgment on a pending publication gate invokes the supported package refresh before success. A refresh refusal preserves the receipt and leaves an idempotent retry. Resolved/output judgments do not refresh a publication package. Approval never happens automatically. Successful normal approval records the actual person/service principal and binds it to the frozen package and receipt IDs on decision resolution. Historical actors are not inferred.

The additive Protocol result contract is `pipeline-visual-judgments-v1`.
`NativeSessionCreateParams.resultSchema` selects this fixed schema; callers do not
supply JSON Schema. `NativeSessionCapabilities.structuredResultSchemas` and the
authenticated node's `supportsStructuredResults` advertise support. Native adapters
retain the validated `structuredResult` only on the exact completed command.
Native pipeline collection is the consumer. Missing capability, result, matching
execution or file/moment binding MUST NOT create a pipeline receipt. Existing
tmux attempts may finish collection, but new admissions use native review sessions.

`PipelineVisualReviewInput` and `PipelineVisualReviewResult` remain on the admitted
review context until package preparation matches their head and closure. Receipt
identity includes the native node/owner/session/generation/lease/command tuple.
The native reviewer is labelled as a service identity, never as the profile owner
acting as a person. Public `RunReviewVisualClaimParams.kind` excludes
`pipeline-reviewed`. The manual RPC MUST refuse attempts to submit that kind.

Legacy delegation fields are required together only for the public delegated-service
judgment RPC, CLI and client action. They MUST NOT restrict native pipeline
verification. Removed person-only configuration is rejected; no compatibility policy is retained.
Normal approval stores `RunDecision.publicationApproval`, including principal,
subject kind, frozen package hash and receipt IDs. PR provenance renders that
resolution; historical missing actors display "Not recorded". These additions
use the existing package release process and require compatible readers before
the new native result producer is activated.

New visual receipts carry `precedence: person-first-v1`; pipeline receipts also
identify the new precedence contract by kind. Frozen readers retain person-first
ordering for those receipts. Legacy-only frozen captures keep their shipped
stored-order interpretation. Policy qualification remains bound to the capture.

## Rejected-criterion repair

Status: Accepted, 2026-10-16, ADR-062 Amendment 10. The producer stays inactive
until compatible readers are released.

### Admission and delivery

`send-feedback` MUST derive the repair from the frozen decision/package and the
latest qualified rejected receipts. The client MUST NOT supply replacement AC
text, evidence, receipt authority or a worker target. The scope MUST retain the
run/generation, package hash, full task registration, rejected receipt IDs,
ACs/reasons/files/moments with each rejected AC's original `proofMode`, original
evidence sources and retained worker owner.
Stale selection, missing rationale, ownership conflict, another active fix or
exhausted existing fix/review budget MUST refuse before dispatch.
The scope MUST name the retained review loop whose existing worker-fix budget
is used; an unavailable loop is a refusal, not permission to create a counter.
Every required reviewer MUST support the repair result schema, and remaining
review admissions MUST cover the required re-reviews, before fix reservation.
Use a v2-capable session, cold when the retained session has fixed v1 schema.
`run.resolveDecision` MUST perform admission before consuming the decision; an
engine-side race/refusal MUST retain or recreate the held gate, not fail the run.
A registration with nested criteria (`parentId`) or without a task registration
MUST refuse; claim selection repairs flat task criteria only. Clients receive
the action only while admission can succeed, and `selectionData` MUST be empty.

The gateway MUST persist one repair identity, budget reservation and delivery
state before calling the existing self-review `sendFeedbackToWorker` path. The
identity MUST include the package and sorted rejection receipt IDs. Retry MUST
reuse that identity, reservation and retained turn. Delivery uses the existing
structured acceptance and uncertain-delivery recovery; artifact creation or
terminal text MUST NOT establish acceptance. No second sender or retry counter
is permitted. An unaccepted reservation MUST remain recoverable and MUST NOT
make its capacity available to a concurrent request.
The reservation is the persisted increment of the named review's `retryCount`;
the existing retry loop MUST consume it without another increment. Undeliverable
reservations stay charged and recoverable through the same repair or normal run
cancellation. An accepted turn MUST NOT be refunded.
The run-store record moves from `reserved` to `delivered` on structured
acceptance and to `completed` when the retained loop returns; an undelivered
record keeps its reason for the re-presented gate.

### Scoped recording and retained claims

The gateway-owned scope is `RecipeRepairScope` in `@farmslot/protocol`, retained
as `artifacts/visual-repair-scope.json`. The normal hosted task recipe wrapper
passes its checked contents through `RecipeRunRequest.repairScope` in
`@farmslot/recipe-runner`. The authoritative digest and active repair identity
MUST remain in the run store. File presence alone MUST NOT activate a scope;
completed/refused scopes MUST be retired and ignored by normal recipe runs.
The scope names its task-relative repair recipe (`recipes/<repairId>.json`); the
wrapper activates repair only when its recipe argument resolves to that file.

The worker MUST author a complete, self-contained repair recipe using the normal
recipe/library composition model. It is a separate task-owned file passed through
the hosted task recipe wrapper's existing recipe argument; the main task recipe
MUST remain unchanged. A repair recipe file without the active run-store scope
MUST NOT activate repair. It MUST explicitly establish its prerequisites
and run from its own `workflow.entry` through normal teardown. It MUST NOT skip
nodes from the original graph, use `stopAfterNode`, introduce per-AC setup fields
or relax normal partial-run refusal. The full task registry remains in the fresh
invocation; unexecuted sibling claims remain `missing` there. Only the checked
source selection below may supply their retained proof.

Every executed assertion MUST retain its normal effect, including setup and
incidental sibling checks. The whole fresh attempt MUST pass the existing
failure-to-status rules. A fresh `failed` or `weak` claim MUST select fresh proof
and block; retained proof MUST NOT hide it. A non-rejected AC may select retained
proof only if the fresh graph did not execute its proof nodes, or its fresh
verdict is `proven`/`awaiting-review`. Rejected ACs always require fresh proof.
The engine rule is narrower than this bound: any non-`missing` fresh verdict
selects fresh proof, so only unexecuted non-rejected ACs keep retained proof.
A rejected AC's fresh claim MUST keep the scope's frozen `proofMode`; `state`
proof MUST NOT clear a `visual` or `mixed` Issue.

The existing engine closure-retention/finalization utilities MUST retain each
referenced original package and write `repair-selection.json` as engine-owned
publication evidence. `RecipeRepairSelection`, owned by Protocol, binds the
scope digest, fresh execution and exactly one source per registered AC. A fresh
claim MUST come from the new attempt; a retained claim MUST name its immutable
original execution and checked closure. Rejected ACs MUST select fresh proof.
Missing/duplicate/foreign claims, changed text, invalid media, altered closures
or an unmatched gateway scope MUST fail validation. The attempt manifest MUST
include the selection and all dependency bytes consumed by its reader.

Canonical package validation MUST validate each source with its own invocation,
recorded source revision and receipt authority. Retained source heads MUST NOT
be rewritten to the repair head; only the fresh attempt binds the current review
head. A retained source MUST supply its own fresh claim, never one it retained. The shared reader MUST select claims according
to the engine selection before the existing claim reducer and UI projection;
there is no fabricated combined execution or client ledger writer.

An independent native review of the actual old-head/new-head repair diff MUST
explicitly classify each retained AC as unaffected. The typed applicability
result MUST bind current head, scope digest, AC ID, original source closure and
rationale to the admitted review command. Missing or affected claims require
fresh proof and block return to a publishable gate. For each retained source,
the diff starts at that source's recorded revision, even across several repairs.
The new head MUST descend from the scope's frozen package head with the same
review base; a different ancestry/base requires a new operator-approved scope.
Old confirmed receipts
remain valid only for their original qualifying source; this applicability
result MUST NOT restamp, replace or override any person's Issue.

### Gate return, learning and conformance

The same run MUST remain non-publishable during delivery, repair, proof and
review. Its normal complete/refresh path returns to the gate only with current
CI and required current-head PASS results, a valid full selection and no Issue.
Both clients MUST use the existing shared action/list model and show progress
or recovery at the triggering action. No automatic approval is permitted.

Every reason MUST remain bound to its source receipt and repair ID in retained
feedback and the existing retrospective `feedbackCandidates` input, using a
stable receipt/repair source key. Protocol adds a receipt/repair variant to the
existing `FeedbackCandidate` type carrying run, receipt, repair and AC identity
and the original reason; it MUST be produced even when no PR exists and MUST NOT
be presented as GitHub feedback. Compatible readers ship before its writer.
Learning adoption and recipe-library publication retain their existing authority.

Conformance MUST cover one rejected AC with a retained confirmed sibling,
current-head applicability refusal, changed/foreign source refusal, no omitted
required check, fresh sibling failure that retained proof cannot hide, complete
repair-graph execution, duplicate and uncertain delivery, exhausted budgets, restart
recovery, learning retention and gate refresh. Live proof MUST use a disposable
retained worker through the production delivery path, with no publication.

### Public surface and release

The existing `run.resolveDecision` and CLI `send-feedback` action are the only
operator entry points. Protocol owns `RecipeRepairScope`,
`RecipeRepairSelection` and a versioned native applicability-result schema;
gateway recovery and recipe-runner are their consumers. The native adapter MUST
advertise that result capability before the gateway admits its review. SDK and
review-dispatch consume the canonical selected sources for both clients.
`capturePipelineVisualInput` and pipeline receipt stamping MUST consume that
per-source selection, replacing their single-source/package-head assumptions
only for an authorised repair; ordinary v1 review binding is unchanged.
`PipelineRepairVisualJudgments` uses `pipeline-visual-judgments-v2`: current
`headSha`, `scopeDigest`, per-source existing visual-judgment results, and retained
rows containing `claimId`, original `recipeRunId`/`closureIdentity`, `unaffected`
and `reason`. Every required independent reviewer MUST agree on applicability.
This is the structured result of the normal admitted review, not another review
admission or a task-file assertion.
Harnesses consume `RecipeRunRequest.repairScope` through their existing hosted
recipe wrapper. No manual manifest/pointer writer or separate proof command is
added. Publish and qualify compatible Protocol/runtime/runner/SDK/provider
versions before activating this producer; existing v1 review results retain
their current meaning and cannot supply repair applicability.

## Inherited acceptance for PR completion

Status: Accepted, 2026-10-16, ADR-062 Amendment 12.

For `pr-complete`, the completion guard MAY consume the direct parent's approved
retained evidence when project, repository, PR number and registered criterion
identities/text match. It MUST validate the selected parent package and the
existing verified review projection. A raw `awaiting-review` verdict MUST NOT
become proven merely because the parent is terminal.
The approved parent's captured receipt IDs and historical qualification remain
authoritative, including the frozen legacy precedence defined by Amendment 11.
Later review changes MUST be reconciled before that snapshot grants inheritance.

Completion and the published PR comment MUST record `source: parent-run`,
`parentRunId`, `headSha` and `ledgerHash`, computed from the original retained
ledger bytes. Original task IDs, recipe run IDs, evidence and frozen decisions
MUST remain unchanged. Inheritance MUST NOT imply proof at the follow-up head.
The required provenance comment MUST succeed before completion. Worker reports
and metrics remain subject to the existing report-publication opt-in. Replay
adds missing provenance to its existing comment without creating a duplicate.
Unavailable, substituted or insufficient evidence MUST retain normal refusal.

The frozen per-flow terminal rule `acceptance.requireFresh: true` MUST select
follow-up evidence instead. Omission permits eligible parent inheritance only
for `pr-complete`; other flows retain their existing acceptance contract.
Fresh completion validates the follow-up's retained selected execution and
its qualified current reviews, without requiring a publication package for
an already published PR. It MUST NOT substitute a parent's task namespace.
Current-checkout deterministic checks and every unrelated ADR-065 prerequisite
MUST still pass independently of the acceptance source.

Before worker delivery, the gateway MAY stage `inputs/inherited-acceptance.json`
with version 1, child run/project identity, original proof provenance and the
matching criterion references. This is a provisional task-closeout reference,
not an engine ledger or publication authority. The local artifact checker MUST
refuse mismatched identity/criteria and ignore it when fresh proof is required.
Gateway completion MUST independently qualify the original retained parent;
a worker-written reference MUST NOT grant completion.

The version-1 reference carries `schemaVersion`, `source`, `childRunId`,
`project`, `parentRunId`, `headSha`, `ledgerHash` and `criteria` as registered
`{ id, text }` references. It contains no replacement engine verdicts. Protocol
owns the shared types and path; gateway preparation stages it, retention freezes
it, and agent-runtime's existing artifact checker consumes it.

## QA case ledger

Status: Proposed, 2026-10-18, ADR-062 Amendment 13.

A task whose handoff flow is `qa` MUST merge each passing execution into
`artifacts/acceptance-status.json` by claim id. A new row replaces the stored row
when the execution addresses the claim, meaning `recipeNodes` is non-empty;
otherwise the stored row stays. Every row MUST carry `recipeRunId`, its case
execution; the top-level `recipeRunId` is the execution projected last. A stored
row whose evidence no longer exists, whose case package (the directory of its
transported `trace.json`) no longer holds its execution, whose text no longer
matches its registration, or that sits in an invalid or schema-1 ledger MUST NOT be
kept. Row moments MUST reference `retainedFrom` when present, else the row's
execution. The merge MUST NOT combine verdicts: when two cases
address one claim, the later execution's row stands. Other flows MUST keep the
single selected execution.

A QA output gate MUST find every row's execution, and the top-level execution,
among the run's selected case packages, or report `evidence-execution-mismatch`.
It binds each registered criterion to the package its row names. Claim-verdict
policy judges, in each package, the claims that package addresses, the rows bound
to it and claims with no ledger row. An unaddressed row bound to another package
MUST NOT block; an addressed weak, missing or failed claim MUST block even when
another case proves the criterion. Untestable overrides bind to the row's case
execution. The completion checker MUST compare each row with the selected claim of
its own case package, read through the same SDK reader and validator.
