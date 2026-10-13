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
Manual `ac set` becomes an untestable override only, with actor, reason and prior
state; it cannot set a normal proven verdict. The proposed [verified override
contract](#verified-claim-overrides) replaces local actor strings as authority.

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
checker uses the public SDK reader and validator to bind the selected package
before deferring verdict checks. The monitor calls that same checker. Flows with
no applicable human gate keep their completion refusal; projects expose no
verdict-waiver flag.

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
2. **Retained inspection.** A schema-v1 task ledger's inspected `proven` row may
   satisfy a schema-v2 visual/mixed claim's `awaiting-review` policy only when
   registered ID/text and cited evidence bind to the same selected execution's
   frozen closure. No evidence or a different attempt cannot bridge the verdict.
   Keep the original schema-v2 verdict and the legacy review source visible;
   this migration rule does not restore a second normal verdict writer.
3. **Criterion text.** Match registered IDs using the shared claim-ID normalizer.
   Trim/collapse whitespace and remove only a leading `AC<n>:` label whose ID
   matches that criterion. The remaining text MUST match exactly. Do not ignore
   changed meaning, a different AC label or mismatched IDs.
4. **Non-recipe proof.** Task-declared unit/revert-test evidence may satisfy its
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
