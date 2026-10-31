# ADR-062: Recorded run evidence

**Status:** Accepted
**Revision:** Accepted amendments 1 and 2 consolidated on 2026-10-13; amendment 3 Accepted under #1011; amendment 4 Accepted under #1015; amendments 5, 6 and 7 Accepted on 2026-10-14; amendment 8 Proposed. Historical/footprint implementation remains pending; curation delivery is recorded below; amendment 18 Proposed on 2026-10-19.
**Date:** 2026-10-12
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
- **P2 Automatic claim evidence.** Nodes declare which claims they prove through eligible expectations. The engine derives verdicts and moments; verified human untestable exceptions use gateway receipts, never local verdict writes.
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

Harnesses inherit the shared HUD, with no per-harness renderers. Its bounded
panel preserves app visibility and displays the complete intent: whole on web,
in at most two lines on native ([ADR-034 Amendment 7](034-recipe-protocol-v1.md#amendment-7-2026-10-20-hud-readability)). Node intents are one concise sentence; lint warns above 80 characters
and fails above 120. The specification defines the rendering requirements.

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

### Completed evidence review and run footprint

**Status:** Accepted, 2026-10-13
**Documentation:** [#967](https://github.com/deeeed/farmslot/pull/967).
Approval accepts the design; implementation remains separate from this docs PR.

#### Context

An engineer should validate an application in Farmslot through recorded evidence.
A completed run should reopen what was reviewed, rather than the latest mutable
files or an analytics page. The same review needs a prominent player, useful
chapters and an honest account of retained storage. Images embedded in a PR are a
secondary distribution channel.

#### Decision

Keep P1 through P8 and the existing recording/timeline/claim contracts. Default UI recording
applies equally to development, bug-fix and QA recipes. Headless state-only runs
retain their non-video evidence; an operator opt-out remains explicit and reasoned.
A run with no executed UI recipe must not acquire a fictitious recording.

Completed, failed and retrospective views default to evidence and the final
result. They reuse the gate review component in read-only `as-decided` context.
The gateway selects the final decision's frozen package identity and closure,
including its verdicts, reviewer outcome, expectations and selected media. The
view never reads a mutable latest pointer as that historical authority. Evidence
navigation, replay and export remain available; publish, rerun, judgment editing
and gate resolution are absent. Diff, observability and analytics remain one tab
away. A final rejected or report-acknowledged snapshot retains that disposition;
it is never labeled approved.

The player is the primary element. Its visible chapter list uses the same claims
and required occurrences as the gate, with verdict and measured range. Selecting
a chapter opens its ordered bounded clips. The active claim follows playback;
there is one shared selection/active-claim rule, not a second chapter model.
Untimed or partly covered claims stay visible without seeking. A fully covered
claim in an interrupted recording remains playable. Existing measured ranges,
1 s padding, segment/gap rules and lazy transfer apply unchanged.

Storage owns footprint measurement and retention. It measures retained regular
file sizes in run-owned artifact, log and transcript locations at completion and
after retention changes. It does not crawl repository dependencies. `Run` carries
the resulting projection, with category totals, measurement time and completeness.
These are logical retained file bytes, not filesystem allocation/free-space
measurements. Virtual clips occupy no additional bytes. Each physical copy counts
once; shared storage objects have one owner so project totals do not double-count
references. A referenced shared object is identified separately from owned bytes.

| Fact                                        | Owner                                       | Shared review consumption                                                   |
| ------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Final review identity and disposition       | Existing gateway decision/package authority | Bind the historical context to that snapshot                                |
| Claims, marker ranges and source digests    | Existing ledger/timeline/artifact contracts | Project chapters and bounded playback                                       |
| Current media availability                  | Storage                                     | Show available, pruned or unavailable without changing the recorded verdict |
| Retained byte counts and retention revision | Storage                                     | Project into `Run`, CLI/SDK and both clients                                |

After media pruning, retain the lightweight frozen review metadata for the run's
history lifetime. Timing and the recorded verdict remain historical facts; media
availability is a separate fact. Unresolved gates and required published
references retain their existing dependency pins. This changes the base rule that
all completed package dependencies expire together: media may expire after its
pins are released, while history metadata remains.

#### Public surface

`@farmslot/protocol` owns additive run-footprint and review-reference DTOs. Existing
run detail/list RPCs and SDK client methods expose them; no separate statistics
store or API family is introduced. The existing CLI detail operation,
`farmslot run get <id>`, shows footprint and final snapshot, and `run list` adds a
retained-bytes column. Project history exposes totals and unknown coverage beyond
the current result page. `farmslot recipe artifacts` resolves completed task/run
review context to the final frozen package and keeps the existing claim selector
and clip export. Command Center and Companion use the same SDK review model.

Extend that model with completed/read-only context, supplied snapshot identity and
availability, and active-claim projection. Reuse `claims`, `selectClaim`,
`selectOccurrence` and playback effects for chapters. Runtime bindings inherit
capture and storage reporting; authors implement neither a recorder nor a disk
scanner. New DTOs are proposed additive protocol changes; model extensions remain
experimental until documented conformance and release.

#### Alternatives considered

- A separate historical screen/player would duplicate gate selection and validation.
- Rebuilding history from current files would change what was reviewed.
- PR images alone would omit exact claim navigation and partial/missing states.
- Client filesystem scans or summing paginated manifests would disagree and miss retained files.

#### Consequences and migration

One review component serves live gates and history. More snapshot metadata must be
retained, while media remains subject to storage policy and existing pins.
Unavailable measurements stay unknown, never zero. A legacy run with no frozen
package shows that limitation and its available unreviewed artifacts; it cannot
claim `as decided`. Backfill footprint only from reachable owned locations. Reuse
verified historical package identities where present, and never manufacture an
approval or recording. Delete replaced completed-view selectors and byte-sum
copies when adoption lands; no compatibility renderer or parallel model remains.

### Shared review curation and saved results

**Status:** Accepted
**Implementation:** Curation and reviewed-line inspection merged in [#963](https://github.com/deeeed/farmslot/pull/963). The saved-result reader merged separately in [#985](https://github.com/deeeed/farmslot/pull/985).
**Specification:** [Review curation and saved results](../reference/review-curation-and-results.md).

#### Decision

Extend the existing native review-publication component and controller for
finding curation and a read-only saved-result context. Reuse the existing
source/diff and document viewers; one renderer serves each job. Protocol owns
shared comment identity/grouping, curation, recommendation normalization,
serialization and the portable review fingerprint. ADR-063's existing dispatch
picker remains the owner of review-request choices.

Bind selected findings, recommendation and evidence choices to the exact reviewed
payload. Retain reviewed source identity and the original report. The existing
run resolver validates an optional fingerprint before restoration and at final
consumption; payload changes invalidate confirmations and stale source reads.
Both publication paths synchronously capture the accepted payload before further
awaits, and refresh refuses writes after resolution or payload replacement.
Legacy callers without fingerprints retain their behavior.

The saved reader consumes existing retained results, falling back to historical
review payloads. It displays raw saved verdict, reviewed SHA and report after
Post, Dismiss or automatic finish. Publication disposition and requested
recommendation/selection are separate facts. Missing receipts, counts and
historical data remain explicit; the view offers no curation or publication.

#### Rationale

Phone review gates lacked finding selection and reviewed-line inspection, and
closed reviews showed publication status without the retained result. Sharing
pure projections and the existing native renderer provides parity without
copying viewers or reconstructing reviewed facts from mutable workspace files.

#### Public surface

Existing `git.show`, `git.diff`, `run.get` and `run.resolveDecision` remain the
public RPCs. The optional review fingerprint and protocol presentation exports
are additive; no public CLI flag, harness hook, result-store schema or review
policy changes. Harnesses inherit retained results and optional selection data.
The internal `post-review.sh --review-input-file` is consumed only by the gateway
slot publisher.

#### Consequences

Native selection resets on payload replacement; desktop retains
its identity-based refresh selections and evidence overrides. Exact selection,
source freshness, immutable report/recommendation, publication-race behavior and
connected acceptance proofs remain in the specification.

This section records the delivered review curation/result contract. Completed
evidence review and run footprint has separate design acceptance and pending implementation. Evidence
engine changes, WARM/COLD dispatch policy, review generation/reruns, account
policy, gate approvals and HTML report rendering remain outside this curation decision.

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
3. Cut over each adopter with its own coordinated change linking this ADR. The intended pre-cutover policy keeps manual verdict steps until engine derivation passes. The pre-cutover overlap of manual verdicts and engine projections was a migration gap, not two approved permanent authorities. Remove manual steps and writing in one coordinated cutover: never run two normal paths or writers. Delete replaced recorders, orchestration, link plumbing and imports; no shims.

Specific repositories, files and rollout coordination belong in separate adoption
records, not these public framework documents.

## Amendment 3 (2026-10-13): Evidence policy and human attestation

**Status:** Accepted, 2026-10-13
**Approval:** Maintainer acceptance of [#1003](https://github.com/deeeed/farmslot/pull/1003).
**Specification:** [Evidence gate policy](../reference/recorded-run-evidence.md#evidence-gate-policy).

### Decision

Separate immutable evidence integrity from claim applicability and verdict
policy. Reader, structure, digest and tamper failures always block publication.
One gateway evaluator owns typed findings; clients do not classify error text.

Add `approve-publish-evidence-attested` only at an unresolved human publish gate.
It requires a written reason and a currently authorized, credential-backed
person. Service, node, background and unauthenticated callers cannot use it;
loopback access or a client-declared identity is insufficient. The attestation
waives only the selected package's claim-policy/binding findings. All unrelated
prerequisites remain enforced. Record the trusted approver, reason, waived
findings and exact decision/package identity in existing run provenance and the
published PR body. Preserve original evidence and verdicts.

Normal policy accepts a declared expected-failure baseline at its declared
assertion, a bound legacy inspection ledger for pending visual claims, matching
criterion text without its matching AC label, and task-declared non-recipe test
proof. The specification prevents these rules from accepting unrelated attempts
or relabeling failures as successful execution.

### Rationale and consequences

A valid regression baseline can fail deliberately; publication policy must not
mistake that result for corrupt evidence. Explicit human attestation provides an
audited escape for policy mismatches while normal binding is corrected. It is
not an automatic fallback, a new verdict writer or permission to replace bytes.

### Public surface and migration

Extend the existing `farmslot run gate --action` command, typed
`run.resolveDecision` request and shared gate action model. Protocol owns action,
input and receipt contracts; existing CLI/SDK transports and gate renderers
consume them. Projects inherit the policy without template or recorder code.

After design approval, ship attested approval first, then normal binding rules
in a separate PR. Both use the existing frozen reader, validator and publication
pipeline. No parallel format, store, reader or client policy mapping is added.

## Amendment 4 (2026-10-13): Verified untestable overrides and selected execution

**Status:** Accepted, 2026-10-13
**Approval:** Maintainer acceptance of [#1015](https://github.com/deeeed/farmslot/pull/1015).
**Specification:** [Verified claim overrides](../reference/recorded-run-evidence.md#verified-claim-overrides).

### Decision

The engine remains the sole normal verdict writer. Project its task ledger only
when the successful-attempt pointer advances. Gate policy MUST bind that
projection to the selected package's `recipeRunId` before comparing verdicts.

One gateway operation records a human `untestable` override for a registered
claim at an unresolved evidence gate. Reuse the credential-backed person and
global-admin authorizer from Amendment 3. Persist the receipt in the existing
Run store, bound to the selected execution and its checked input closure. Client
actor strings and worker-written overrides confer no authority.

Derive the effective review row from immutable engine claims and gateway
receipts. Keep the engine verdict, override chain and reason visible. One shared
`isAuthorizedOverride` predicate checks the whole chain in both claim satisfaction
and task binding. An override means untestable, never proven. It grants neither
publication approval nor a waiver of integrity or unrelated prerequisites.

The operation leaves the gate unresolved. Receipt changes invalidate prior
policy evaluation and publication confirmation. The canonical package owner
refreshes and re-presents a pending publication gate after the receipt is durable.
An override changes the evidence verdict, not the reviewed code or evidence:
existing review results remain valid, and no review round is requested or spent.
Only an actual change to the code or reviewed evidence requires another review.
Historical/completed runs stay read-only. Failed persistence leaves no effective
override; retry cannot create an unsigned intermediate verdict.

Completion MUST present a valid selected package with unresolved claim verdicts
at its existing human gate. Those verdicts continue to block approval. Integrity
and unrelated completion failures still refuse; reaching review is not admission.

### Rationale and consequences

The existing free-text actor cannot establish human authority. Changing engine
claims would destroy reproducible derivation. Gateway receipts provide one
auditable exception without a second normal writer or evidence rewrite.
Unverified old chains remain blocking; migration never signs them retroactively.

### Public surface and migration

Extend `farmslot run gate` and the existing shared gate action/renderers with
`mark-untestable`, routed to typed `run.overrideClaim` without resolving the gate.
Protocol owns request/receipt types and the shared chain predicate. CLI, SDK and
both clients consume this boundary; providers inherit it without recording or
verdict code. Replace schema-2 local `ac set` authority with this verified path
after conformance, with no compatibility writer. The specification names the
parameters, identity checks and refusal cases. Update completion/refusal guidance
in the same cutover so workers request human review rather than writing overrides.

## Amendment 5 (2026-10-14): Selected evidence and run contract version

**Status:** Accepted, 2026-10-14
**Specification:** [Selected evidence run contract](../reference/recorded-run-evidence.md#selected-evidence-run-contract).
**Implementation:** [#1030](https://github.com/deeeed/farmslot/pull/1030), merged; package publication and rollout remain separate.

### Decision

The gateway stamps new runs with `recordedEvidenceContractVersion: 1` at creation.
Existing unversioned runs remain pre-cutover records; loading or replay never
backfills the field. An unsupported version refuses evidence admission.

The engine derives each attempt's publication manifest from its registered
artifacts and claim results. Publication freezes only the selected execution and
its complete input closure, including headless executions. Selection errors
never fall back to the task ledger or another attempt.

The shared review model shows Legacy only for pre-cutover data without a current
contract. Unverifiable newer data is Invalid with a typed reason and recovery
action. Retained reports and failed packages remain readable without granting
admission or measured proof.

### Rationale and consequences

Missing metadata cannot establish age. A gateway-owned version supplies one
durable boundary without dates, path guesses or retroactive evidence changes.
Projects inherit the engine producer and delete their selection writers after
consumer conformance. No compatibility writer or parallel evidence format is added.

### Public surface and migration

Protocol owns the run version, failure codes and existing publication-manifest
types. The existing recipe artifact CLI, runner writer and SDK review model expose
them with default execution behavior; no additional command family or flag is
needed. Gateway reads, both clients and historical projections consume this one
contract. Implementation and package publication are recorded separately.

## Amendment 6 (2026-10-14): Authenticated visual review and QA binding

**Status:** Accepted, 2026-10-14.
**Specification:** [Authenticated visual review](../reference/recorded-run-evidence.md#authenticated-visual-review).
**Implementation:** [#1037](https://github.com/deeeed/farmslot/pull/1037), merged. Package release and deployment are separate delivery records.

### Decision

The gateway records a credential-backed person's visual judgment in the existing
Run store. It binds the judgment to one selected execution, its checked input
closure and the engine's exact moment references. Actor and time come from the
gateway. Confirming or rejecting a visual claim feeds the existing engine reducer;
it never changes retained package or task-ledger bytes.

QA gates bind task criteria to schema-2 engine claims and their execution identity.
Remove the schema-1 file-reference binding. State assertions, pending visual
claims and authorized untestable exceptions keep their existing rules.

### Rationale and consequences

A worker note or actor string cannot authenticate a visual verdict. One persisted
human fact and one engine reducer preserve the original recording while making
the review reproducible. Selected captured output can be reviewed after a run
ends; this records evidence meaning and grants no publication or gate approval.
Historical gate snapshots keep their captured judgments and remain read-only.

### Public surface

Use the existing `farmslot run gate` actions `confirm-visual` and `reject-visual`,
with its claim, execution and reason selectors. `RunRpc.reviewVisualClaim` exposes
the same authenticated operation. Protocol owns receipt/request types; the runner
owns `deriveReviewedRecipeClaims` and the SDK re-exports it through `/evidence`. The shared
review model supplies both clients. These additive contracts are experimental
until their coordinated release; no harness writer or compatibility path is added.

## Amendment 7 (2026-10-14): Delegated visual judgments and Compare by AC

**Status:** Accepted (2026-10-14). Implementation and live gate acceptance are pending.
**Specification:** [Delegated visual judgments](../reference/recorded-run-evidence.md#delegated-visual-judgments) and [Compare by AC](../reference/recorded-run-evidence.md#compare-by-ac).

### Decision

Add `lead-agent-reviewed` alongside `person-reviewed` in the existing visual
judgment receipt. A delegated reviewer uses its own authenticated agent identity.
The gateway records the AC, verdict, rationale and exact evidence digests through
the same Run-store writer and engine reducer. Per-project policy may allow this
kind to satisfy visual claims; person-only criteria still require person review.
Label the result "agent-reviewed (delegated by <name>)" in the UI and PR body.
It never represents a human judgment or grants publication authority.

Captures may declare `ac` and `role`: `before` for the reviewed base commit,
`after` for the reviewed head, and `review` for other observations. The engine
records those bindings with the existing artifact, claim and moment identities.
It checks the captured source against the reviewed revisions. Missing bindings
remain Unassigned; filenames, worker prose and capture order supply no binding.

Extend the shared evidence review model and existing media viewers with
"Compare by AC". Each claim row shows its text, canonical verdict, before/after
captures, synchronized image zoom and its recorded video moment. Preserve missing
sides and multiple captures. Command Center and Companion share grouping and
selection; only platform rendering differs. PR evidence renders from the same
bindings through the existing engine publication manifest.

### Rationale and consequences

Delegation should be explicit about who inspected the evidence. An agent's
judgment can close a permitted visual claim without borrowing a person's
credential. Existing assertion, integrity, independent-review, CI and publication
gates still apply.

A flat screenshot grid cannot explain which criterion changed. Explicit bindings
connect comparison to the evidence already retained. A baseline remains a
comparison dependency, never proof for the selected head execution. Frozen
reviews retain both sides and their source identities. No evidence store,
parallel writer, filename migration or verdict reducer is added.

### Public surface and migration

Extend `run.reviewVisualClaim` and the existing `farmslot run gate` actions with
the judgment kind. Protocol owns the receipt and per-project policy types; the
gateway checks identity and policy. The existing shared model supplies the proof
kind and reviewer label. Implement this bounded judgment change first, then the
comparison producers and view. Both follow this amendment's design acceptance.

Existing `farmslot recipe run` capture nodes accept the optional bindings;
`farmslot recipe artifacts` exposes them without another command or flag.
Protocol owns the binding types and artifact contracts; the runner owns capture
registration and publication derivation. The experimental
`@farmslot/adapter-sdk/evidence` model adds comparison rows and shared image
transform state for both clients. Harnesses implement capture/target bindings and
inherit recording, claim validation, comparison and publication. Migrate templates
and consumers before removing their role guesses or pair-mapping copies.

## Amendment 8 (2026-10-14): Retained criterion-link snapshots

**Status:** Proposed, scoped by the lead to the #1044 implementation and review.
**Specification:** [Retained criterion-link migration](../reference/recorded-run-evidence.md#retained-criterion-link-migration).
**Implementation:** [#1044](https://github.com/deeeed/farmslot/pull/1044), pending review and merge.

### Decision

Preserve already verified historical criterion-to-file relationships once in a
private gateway-owned snapshot outside the original task artifacts and frozen
publication inventory. Explicitly inventoried task storage identities establish
migration scope, including tasks with no retained Run record. Missing Run metadata
does not establish age and MUST NOT be backfilled.

The migration consumes a frozen, operator-reviewed relationship inventory and
checks the original handoff, manifest and linked file digests. Normal readers
consume the retained links without interpreting manifest `covers`. Existing
engine-ledger reads retain precedence. Snapshot failures have a separate display
caption and never supply a verdict, task binding, moment or gate prerequisite.

### Rationale and consequences

Deleting the old manifest-derived link reader would hide historical relationships
whose tasks have no ledger. Keeping that reader would continue deriving new
relationships after the writer cutover. A finite migration retains the existing
relationships and original bytes while removing the ongoing parser.

Snapshots bind exact task storage identity and original byte digests. They remain
private display metadata, with the same retention ownership as their source task.
Moving a task or changing its source bytes requires an explicit migration decision;
the reader cannot guess or repair the identity. Completion and frozen decisions
continue to use their existing engine and publication authority.

### Public surface and migration

Gateway maintenance operators run the one-time retained-link import described in
the owning specification. It adds no RPC, recipe command, SDK export or harness
writer. Existing `TaskProgressResult.acceptanceEvidenceLinks` and its error caption
carry the display result to both clients; the experimental
`@farmslot/adapter-sdk/evidence` model consumes the existing `evidenceLinks` input.
Links stay task-relative and untimed. Providers and players inherit existing
artifact transport. Import and verify snapshots before deploying #1044's reader
cutover; package release and deployment remain separate delivery records.

## Amendment 9 (2026-10-16): Per-criterion confirmation without a text form

**Status:** Accepted. Arthur approved the wording and existing per-AC audit trail on 2026-10-16; paired design review approved revision 2 before implementation.
**Implementation:** [#1179](https://github.com/deeeed/farmslot/pull/1179), coordinated rollout pending.
**Specification:** [Per-criterion confirmation](../reference/recorded-run-evidence.md#per-criterion-confirmation).

### Decision

Both clients show the selected criterion's recorded pre-validation before its
judgment controls. A qualified `lead-agent-reviewed` receipt supplies its visual
verdict, written rationale and bound reviewed files/moments. Engine assertion
results and moments are labeled checks, not visual pre-validation. Task-ledger
and worker notes are not visual pre-validation sources. Where no qualified
visual review exists, show "Not recorded"; never invent an assessment.

Under Amendment 7, a permitted qualified delegated judgment already satisfies
its AC and retains its delegated provenance label. A person's additional "Looks
right" on that AC is optional. Person-only criteria remain person-only; this
amendment does not invalidate delegation or require another person judgment.

"Looks right" records a `person-reviewed` + `confirmed` judgment in one tap,
without a reason field. "Issue" records `rejected` and requires a nonblank reason.
Only authenticated person confirmation may omit prose. Delegated judgments of
either verdict and ledger-embedded recipe judgments retain their written-rationale
requirement. No synthesized reviewer prose, new judgment writer or compatibility
adapter is introduced. Existing request/receipt qualification, engine validation,
SDK request construction, CLI and both clients change together.

The authenticated writer still binds every receipt to the selected execution,
input closure, claim, exact files/moments, trusted reviewer and time. The server
refuses a rejection or delegated judgment without its rationale. Raw package
validation still refuses a reasonless embedded judgment. Historical recorded
bytes stay immutable; the existing reducer consumes only qualified receipts.

After all required ACs are satisfied by their bound assertions and permitted
qualified judgments or authorized exceptions, the refreshed package uses normal
publish approval without another evidence-attestation text field. Its audit is
the authenticated per-AC reviewers and the existing frozen
`prPackage.visualJudgmentReceiptIds`, including the existing PR provenance.
Normal publication authority remains unchanged: this adds no separate normal-
publish approver receipt, person-only publication rule or identity field.

Changed judgments still require the existing package refresh. While that is
outstanding, show "Refresh package" and withhold approval. Source/head, CI,
integrity, independent reviews, package freshness and existing publication
authority remain mandatory. Approval cannot confirm an unjudged AC. A genuine
separately offered evidence-policy waiver keeps its explicit scope and written
reason; AC confirmation is not a blanket policy waiver.

### Rationale and consequences

The per-AC receipt records the person's decision without a second text form.
An issue retains enough information to repair it, and a delegated pre-validation
retains its rationale. The existing evidence, authority and publication models
remain the sources of truth.

### Public surface and migration

`RunRpc.reviewVisualClaim` and its request/receipt types remain owned by
`@farmslot/protocol`. Omitted `kind` still means `person-reviewed`.
`reason` may be omitted only for person confirmation. `farmslot run gate --action
confirm-visual` does not require `--reason` for person review; `reject-visual`
and either delegated action require it. The canonical protocol qualifier,
runner's claim/package validation, gateway writer and CLI validation must agree.

`@farmslot/adapter-sdk/evidence` owns per-claim pre-validation, selected media and
judgment requests. `@farmslot/review-dispatch` consumes those rows and owns the
shared approval/waiver presentation. Command Center and Companion switch together.
The existing engine reducer consumes the receipts; harnesses inherit the
coordinated protocol/runner/SDK release without a new hook. No endpoint, manifest
field, task mark, publication identity rule or second reducer is added. Release
changed installed packages together before provider cutover, under their existing
experimental versioning.

## Amendment 10: return rejected criteria to the retained worker (2026-10-16)

**Status:** Accepted by the lead on 2026-10-16 after paired design review, with
three implementation clarifications folded into the specification: frozen
rejected-claim proof mode, a separate task-owned repair recipe, and receipt/repair
feedback provenance. Ships in #1209. This is the authorised follow-up to the gate
redesign; it does not change publication authority.

### Decision

When a package contains qualified visual Issues, both clients offer one primary
action, "Send back to agent". The gateway derives its ACs, reasons and exact
files/moments from the current trusted receipts. The previously handled but
unoffered `send-feedback` action enters the retained self-review fix path and
its delivery recovery.
Writing feedback alone is not delivery. One accepted request spends one existing
worker-fix round; a duplicate or uncertain retry keeps the same charge and turn.

The retained worker authors a self-contained repair recipe for the rejected
criteria, composing normal setup, checks and teardown. Its entire graph runs;
there is no node skipping, assertion suppression or partial-run waiver. Fresh
failures always block and cannot be replaced with earlier proof.
The engine retains the previous proof packages and
writes one explicit claim-to-source selection covering the whole task. Each
selected claim keeps its original execution, closure, media and receipt identity.
Neither a client-combined ledger nor relabelled old proof is permitted.

Retaining bytes alone does not prove applicability after a source change.
An independent native reviewer must explicitly assess each retained claim
against the actual repair diff at the new head. Its typed result binds the
repair scope and old source closure to that head. A missing or negative result
requires fresh proof; it cannot clear an Issue. Earlier confirmed receipts are
qualified against their original sources and are never reissued. The repair
head must descend from the frozen package head with the same review base;
otherwise a new operator-approved scope is required.

Completion refreshes the package and returns the same run to its gate only after
current-head CI, required reviews and complete qualifying proof pass. Reasons
remain attached to the repair and enter the existing retrospective learning
path. No automatic publication or direct recipe-library write is introduced.

### Rationale and consequences

The current publication reader accepts one selected attempt. Its retained
baseline media is not current claim authority. Explicit engine-owned source
selection is necessary to re-prove a subset without discarding valid judgments
or pretending a skipped check ran. It also makes older proof visible as older
proof. Reuse fails closed when its current applicability is unverified.

### Public surface

The CLI and clients retain `run.resolveDecision` / `run gate --action send-feedback`.
Protocol owns the frozen repair scope, source selection and typed applicability
result. The existing recipe-runner request receives that scope from the hosted
task wrapper; engine finalization writes its selection. SDK/review-dispatch
project the selected sources into the existing shared AC list. Harnesses inherit
the normal wrapper and compatible package cut, with no manifest-writing hook or
new shell flag. These experimental additions require coordinated minor releases
and compatible readers before producer activation. Normative details follow in
[the recorded-evidence specification](../reference/recorded-run-evidence.md#rejected-criterion-repair).

## Amendment 11: independent visual verification and judgment refresh (2026-10-16)

Accepted by the lead after paired design review of revision 4, with native pipeline review transport required in the same change. Updated by Arthur at 14:40 to remove all person-only policy. Ships in #1185. This supersedes Amendments 7/9 on opt-in pipeline verification, person-only policy, receipt order, manual refresh and the normal publication approver audit. Amendment 10 remains the separate retained-worker repair loop.

Independent pipeline visual verification satisfies an AC by default. The reviewer is a gateway-admitted native `review` context, bound to node, owner, session, generation, lease and command. Its session must differ from every worker/fix session of the run, including their retained session histories.

The native runner adapter declares a structured-result capability. The review command supplies the protocol-owned per-AC result schema. The adapter records one validated typed result for that bound command's completed turn. Gateway collection uses only that result, never assistant prose, tool text, signal files, shared task results or overall code-review PASS. Pipeline reviewers use native transport, including runs with tmux workers. The primary worker retains its transport and session. Existing tmux reviews and unsupported adapters leave visual ACs at "Needs a check"; they do not gain authority retroactively. Existing review budgets remain unchanged.

Retain the review's launch-time execution and input closure. When the publication package freezes the same closure, the existing visual writer stamps `pipeline-reviewed` receipts with the native reviewer identity, existing reviewed-file digests, engine moments and rationale. Mismatches remain unchecked. Stamp once per reviewer binding, closure and AC. That stable key, not the package snapshot, identifies a retry. A stamp at a pending publication gate invokes automatic refresh once; the refreshed package reuses those receipts without re-stamping. Public manual-review RPC requests cannot manufacture this kind. Legacy delegated-service credentials, allowlists, delegators and labels remain unchanged.

Every visual AC accepts a qualified pipeline receipt; no receipt means "Needs a check". Delete project and per-claim person-only configuration, parsing and checks. Extension needs no configuration. A person may still choose Looks right or Issue on any visual AC. Legacy delegation fields remain consumed by the public delegated-service judgment RPC, CLI and client action; they do not govern pipeline verification. Current delegation changes require refresh; historical projections retain frozen qualification.

Within the same execution and closure, the latest person receipt outranks agent receipts; among agent receipts, the latest wins. Only a later person receipt or a new selected execution clears a person Issue. Person confirmation always qualifies; authorized untestable exceptions retain their scope.

A judgment at a pending publication gate automatically invokes the supported package refresh before success. Failure preserves its receipt, reports the refusal and keeps Refresh package available. Retry reuses the receipt. Output-review judgments have no publication package to refresh. Never approve or resolve a gate automatically.

Stamp normal approval's principal ID, name and person/service subject kind on its decision resolution, bound to the package and frozen receipt IDs. Render it in PR provenance. Never mutate the frozen package or infer historical actors; show "Not recorded". Publication authority and other prerequisites remain unchanged.

Both clients use one AC list: "Proven", "Verified by agent", "Checked", "Issue", "Untestable", "Needs a check". Evidence and optional Looks right / Issue stay in place; only Issue needs prose. Overrides and warnings open on demand. Send back delivery and scoped re-proof remain the authorised follow-up; until then, Issue blocks.

### Public surface

Protocol owns `PipelineVisualJudgments`, native result-schema/result event fields, receipt kind/identity, legacy delegation policy and decision audit. The native runner adapter owns capability declaration, schema-constrained output capture and validation. Native review collection is the named consumer. Public `RunRpc.reviewVisualClaim` keeps manual kinds. SDK and review-dispatch supply both clients. Ship compatible readers and result-capable native adapters before writer activation.

## Amendment 12 (2026-10-16): Inherited acceptance for PR completion

**Status:** Accepted (Arthur, 2026-10-16)

### Decision

A `pr-complete` run may satisfy acceptance with its parent's approved, retained
evidence for the same project and pull request. Every registered criterion must
match and remain proven under the parent's existing evidence and review rules.
Completion and its PR comment identify the proof as inherited and retain the
parent run, proof head and original ledger hash. They never claim execution at
the follow-up head or rebind the parent's task or engine artifacts.

An explicit per-flow `acceptance.requireFresh` keeps acceptance bound to the
follow-up task. Deterministic checks always validate the follow-up checkout.
[ADR-065](065-fail-closed-run-lifecycle.md) continues to own all other completion
prerequisites, including worker idle and publication authority.

### Rationale and consequences

Review and CI follow-ups should not require another product login to repeat
already approved AC proof. Inheritance preserves the original proof identity;
missing, corrupt, unrelated or unproven parent evidence grants no completion.

### Public surface

The existing run completion output and PR comment carry inherited provenance.
`WorkerTerminalAcceptanceRules` in `@farmslot/protocol` gains optional
`requireFresh`, consumed by the existing contract resolver and gateway completion
guard. Harnesses inherit this behavior through their existing terminal rules.
`InheritedAcceptanceProvenance`, `TaskInheritedAcceptanceReference` and
`INHERITED_ACCEPTANCE_INPUT` in the same package connect gateway preparation,
retention and the existing runtime artifact checker. The checker accepts only a
matching provisional reference; gateway completion revalidates parent authority.
`acceptanceCriteriaMatch` supplies their shared criterion identity/text binding.
`registeredAcceptanceCriteria` supplies the existing positional registration to
both runtime and gateway readers.
There is no new command, endpoint, verdict writer or client gate component.
The additive contract follows the existing coordinated package versioning.

## Amendment 13 (2026-10-18): One QA task ledger across case packages

**Status:** Proposed. Lead-assigned fix for mobile release QA finding I1; needs acceptance.
**Specification:** [QA case ledger](../reference/recorded-run-evidence.md#qa-case-ledger).

### Decision

A QA run records one engine package per case. Under Amendment 4 each passing
case replaced the task ledger, so it held only the last case's verdicts. QA
output gates also bound every criterion to that one execution and required every
case package to prove every registered criterion, which a suite whose cases prove
different criteria can never meet.

For a task whose handoff flow is `qa`, the runtime merges each passing execution
into the stored ledger by claim id. A row the new execution addresses (one of its
selected nodes proves the claim) replaces the stored row; every other stored row
stays. Each row names its case execution in `recipeRunId`; the top-level
`recipeRunId` names the execution projected last. A stored row is kept only while
its evidence exists and its case package still holds its execution. The merge
selects engine rows; it never combines verdicts, so
when two cases address one criterion the later execution's row stands and the
gate below still judges the earlier case's claim.

QA output gates bind each criterion to the selected case package its row names.
A row whose execution is not a selected case package is an execution mismatch. A
case package answers for the claims it addresses and the rows bound to it, so its
unaddressed `missing` rows do not block a criterion another case proves. A weak,
missing or failed claim that a case addresses still blocks, even when another case
proves the criterion. An untestable override binds to the row's case execution.
The completion checker that `mark complete` and the monitor's terminal-signal check
run binds each row to its case package the same way before deferring verdicts.

Other flows keep Amendment 4 unchanged: one selected execution, no row execution.

The shared evidence review model still loads one package, the last projected case,
so run detail and output review show that case's claims until it supports several
packages. Deploy the gateway before the node agent-runtime: an older gateway binds
merged rows to the last execution and refuses them.

### Public surface

`AcceptanceCriterionStatus` in `@farmslot/protocol` gains optional `recipeRunId`;
`acceptanceRowExecution` in the shared acceptance contract resolves a row's
execution. The shared ledger validator accepts it and checks the row's moments
against it. `setDerivedClaims` in `@farmslot/agent-runtime` merges for every
existing recipe entry point, and its claim review gate binds rows to their case
packages. There is no new command, endpoint or verdict writer.

## Amendment 14 (2026-10-18): Capture binds before the first proof node

**Status:** Accepted (lead, 2026-10-18). Ships in #1296.

### Decision

Full-run capture binds before the first proof node, for every recording target.
A proof node is a UI node or an assertion node (`assert_output`, `assert_json`,
`assert_file`, `ui.wait_for`), including one inside a called recipe. After
binding, the engine waits one `EVIDENCE_PADDING_MS` (1 s) before running that
node. Setup before it that proves nothing, such as an in-recipe app restart,
state seeding or a state read, stays unrecorded. Which runs require recording is
unchanged: a recipe with a UI node requires it, and explicit recording of a
recipe without UI nodes still starts at run entry.

### Rationale and consequences

Capture used to bind before the first UI node. A recipe that proves claims with
assertions before its first tap recorded none of them, so the engine downgraded
its visual claims to weak. In mobile release QA run e29f5a2b, QA-03 started
recording 75.5 s after its first node, after the app restart, three venue
`assert_output` nodes and the book gate, and AC-1..3 came out weak; QA-08 left
about 88 s unrecorded.

The lead-in is needed because a recorder's first frame trails its start, and a
recorder without clock evidence bounds frame zero only by its lifetime. On an
owned emulator with `adb screenrecord`, a trial without the lead-in measured the
assertion at [-370, +110] ms, inside that uncertainty, and its visual claim stayed
weak. With the lead-in it measured [+626, +1120] ms and the claim was awaiting
review. QA-03's first recorded segment has a 793 ms window, so a recorder whose
start uncertainty exceeds 1 s can still leave the first proof node outside.

One rule serves every target. A device or simulator recorder could start at run
entry, but setup that proves nothing needs no footage, and a per-target split
would make the capture window depend on the recorder. Recordings now start
earlier by the setup between the first assertion and the first UI node, plus the
1 s lead-in, which uses more of the existing duration and byte limits. A run that
binds at a proof node takes 1 s longer; explicit recording without UI nodes still
binds at run entry, with no lead-in.

Target resolution moves with the bind point. A recipe that launches or replaces
its browser after an assertion now binds the process that assertion saw, so
authors keep launch and replacement before the first proof node, as they already
do before the first UI node.

### Public surface

No new API. `@farmslot/recipe-runner` changes when the existing full-run
recording starts; `RecordingTargetProvider`, `VideoRecorder`, the recording
artifacts and the recording-required policy are unchanged. Harnesses inherit it
with their next recipe-runner version. The normative timing rule is in
[the recorded-evidence specification](../reference/recorded-run-evidence.md).

## Amendment 15 (2026-10-18): Recorders bound frame zero at start and through restarts

**Status:** Accepted (lead, 2026-10-18). Ships in #1304.

### Decision

A recorder may bound its first segment's frame zero at runtime before its start
returns. An active recording that restarts capture may expose `ready()`, which
resolves once the current segment's zero is bounded, waiting through a restart.
The engine awaits it before every proof node. A recorder with a segment limit
may restart capture inside `ready()` when the current segment nears that limit,
so the restart falls between proof nodes rather than inside one. Amendment 14's
bind point and 1 s lead-in are unchanged; the engine has no roll API.

Android `adb screenrecord` starts each segment only once its file holds bytes.
The muxer writes its header only after the encoder's first output, so frame zero
precedes them. The segment's clock is `[spawn, first bytes]` instead of the
process lifetime, which also spans any static screen before the stop. Its
`ready()` restarts a segment older than 150 s, 30 s before the 180 s limit,
after recording one `EVIDENCE_PADDING_MS` past the previous node, so that node's
end and playback padding stay on camera. The iOS `simctl` recorder is unchanged
and still bounds zero by its process lifetime.

### Rationale and consequences

After Amendment 14, a 0.92.27 replay of QA-03 on a Pixel 6a still left AC-1..3
weak: 4 of 18 AC-1 assertion indices fell outside recording. Three venue
assertions started inside segment 0's 1737 ms lifetime-bound zero window, longer
than the lead-in, and `limit-price` started inside segment 1's 1127 ms window,
right after the 180 s roll the runner could not see. On an owned emulator with a
static screen, the file's first bytes came 572 ms after spawn, while the lifetime
bound put zero up to 5126 ms after spawn because of the static tail.

With the bounded start alone, a replay on the same device measured 17 of 18
AC-1 indices: the venue assertions moved inside segment 0 ([+1003, +1683] ms on
a 680 ms window). AC-1..3 stayed weak only because a 3 s `ui.wait_for` spanned
the 180 s limit. QA-03 spends 99% of its 349 s proof span inside proof nodes, so
a limit-driven restart almost always lands inside one; restarting at a node
boundary from `ready()` avoids that.

Recording starts take a little longer, until the header is written, and a long
recording gains a restart gap about every 150 s, between nodes. A proof node
that arrives during a restart waits for the new segment. A single proof node
longer than 30 s can still span the 180 s limit and stay outside recording.
Harness recorder wrappers must forward `ready()`, as they forward `snapshot()`.

### Public surface

`ActiveVideoRecording.ready?()` in `@farmslot/recipe-runner`: optional, consumed
by the engine before every proof node, produced by `@farmslot/adapter-rn`'s
Android recorder, and passed through by `startSegmentedRecording` and the
recording-limit wrapper. The Android recorder's timing evidence adds each
segment's `zeroBoundAtUnixMs`, and its clock source is
`adb-screenrecord-first-write`. The MetaMask harness forwards `ready()` from its
`withRecordingOutcomes` wrapper with its dependency bump. Normative timing rule:
[the recorded-evidence specification](../reference/recorded-run-evidence.md).

## Amendment 16 (2026-10-18): A restarted segment gets the first bind's lead-in

**Status:** Accepted (lead, 2026-10-18). Ships in #1315.

### Decision

`ready()` resolves only once the current segment has recorded one
`EVIDENCE_PADDING_MS` past its latest possible frame zero. A proof node that
follows a capture restart therefore gets the same lead-in as the first proof node
after the bind (Amendment 14). Android `adb screenrecord` implements it in its
`ready()`; a segment older than that resolves at once, so only a node within one
padding of a segment's zero waits: one right after a restart, or the first proof
node of an explicit recording that started at run entry, which had no lead-in.

### Rationale and consequences

A replay of QA-03 (mobile release QA run e29f5a2b) on the Pixel 6a with
recipe-runner 0.39.4 and adapter-rn 0.22.27 measured 17 of 18 AC-1 moments, and
AC-1..3 stayed weak. The 13.4 s `ui.wait_for` `ac1-guard/guard-gone` started at the
third segment's latest frame zero, right after the 150 s roll. In the previous
segment its start bound began at 151845 ms, inside that segment's 152070 ms, so the
node overlapped both segments across the restart gap and counted as outside
recording. Amendment 15 waited for the new segment's zero but gave the node no
lead-in. With it, the node starts at least 1300 ms after the previous segment's
stop, clearing that segment's latest possible media end (its stop plus 525 ms: a
308 ms zero window and 217 ms of media past its lifetime) by 775 ms. One padding
suffices while a segment's media runs past its stop by less than one padding plus
the next segment's zero window. A node right after a restart now waits up to 1 s
more, about once every 150 s of recording.

### Public surface

No new API. `ActiveVideoRecording.ready()` resolves up to one
`EVIDENCE_PADDING_MS` later after a restart. Harness wrappers already forward
`ready()`. Normative timing rule:
[the recorded-evidence specification](../reference/recorded-run-evidence.md).

## Amendment 17 (2026-10-19): Evidence stills are WebP

**Status:** Accepted (lead, 2026-10-19).

### Decision

Stills the engine names and writes from a recording are lossy WebP at quality 85. This covers the automatic proof stills and the stills derived from recorded frames. Each still is one `.webp` file registered with `mimeType: image/webp`, and that file is the evidence: no PNG original is kept. Its sha256 goes into the artifact manifest like any other file, so gate packages, publication selection and refresh digests cover the WebP bytes.

One setting chooses the format: `stillFormat`, either `webp` (the default) or `png` (lossless). It sits in the recording policy next to `maxFps` and `maxSize`, and is set the same way: in the run's `recordVideo` options or with `recipe run --record-still-format`.

Recorders keep handing over PNG frames (a still derived from video is its decoded frame), and recipe-runner encodes each still once before registering it. It uses libwebp compiled to WebAssembly, an npm dependency of recipe-runner, so every recorder shares one encoder and no host binary is needed. Recorders that share it: capture-helper, CDP screencast, the Android mirror, and stills ffmpeg derives from video.

Screenshots taken by `ui.screenshot` keep the format of their path, including its default `screenshots/<node>.png`, because recipes and ledgers refer to those paths. A harness's own screenshots registered as `image/png` are one example.

Retained runs keep their PNG stills. Every consumer chooses how to show or package a still from that file's `mimeType` or extension.

### Rationale and consequences

The owner asked for smaller evidence and judged lossy WebP good enough for nearly every check.

Measured on six real product stills (976x1040 and 860x1080):

| Format                                               | Size per still |
| ---------------------------------------------------- | -------------- |
| Raw PNG (stored blocks, before capture-helper 0.3.5) | 3.7–4.1 MB     |
| Deflated PNG                                         | 250–384 KB     |
| WebP q85                                             | 53–85 KB       |

Encoding with WebAssembly takes about 110 ms per still.

What lossy WebP changes in the pixels:

- **Flat areas:** 98.5% of pixels are within ±2 per channel of the original.
- **Edges and text:** 2–4% of pixels differ by more than 8, at most 89; text stays readable.

A check that needs exact pixel values sets `stillFormat: png`.

capture-helper cannot do the encoding. macOS ImageIO does not write WebP on the farm hosts, the hosts' ffmpeg builds have no libwebp, and Chrome screencast frames are PNG or JPEG only. capture-helper therefore keeps writing deflated PNG (0.3.5), which recipe-runner converts.

Clients, the gateway publish packager and model reviewers already decide per file. Today several of them still list only `png|jpg|jpeg|gif`. Every such list must accept `image/webp`, deployed, before any worker runs a recipe-runner that writes WebP. The writer release is the last change.

GitHub renders WebP in PR bodies, and the vision models used as reviewers accept it.

### Public surface

**`@farmslot/protocol`**

- `RecordedEvidencePolicy.stillFormat?: 'webp' | 'png'`; `DEFAULT_RECORDED_EVIDENCE_POLICY.stillFormat` is `'webp'`.
- Consumers use the existing checks, `isRunArtifactImagePath` (images the clients show inline, already including `.webp`) and `isRunEvidenceVisualArtifact` where a list also covers video, instead of their own extension lists.

**`@farmslot/recipe-runner`**

- `RecipeVideoRecordingOptions.stillFormat` (the run's `recordVideo` options, which harnesses set) and `recipe run --record-still-format webp|png`.
- Engine stills are `stills/<key>-<attempt>.webp` and `stills/recorded-<n>.webp`; `ui.screenshot` files are unchanged.
- `ActionExecutionContext.captureRecordingSnapshot` still returns PNG at the path the caller asks for, so harness callers are unchanged.

**Consumers**

- Every image list accepts `image/webp`: Command Center (artifact, lightbox, evidence, family and eval views), Companion, and the gateway's artifact typing, eval packages, PR body and publish packager, and reviewer inputs.
- The artifact route already serves `.webp` as `image/webp`.

**Harnesses** inherit the change; a harness needs no code change, only its dependency bump.

Normative rule: [the recorded-evidence specification](../reference/recorded-run-evidence.md).

## Amendment 18 (2026-10-19): Criteria checked in code review

**Status:** Proposed
**Specification:** [Claim registration and verdicts](../reference/recorded-run-evidence.md#claim-registration-and-verdicts), [Evidence gate policy](../reference/recorded-run-evidence.md#evidence-gate-policy).

### Context

Some acceptance criteria describe the change itself rather than runtime behaviour: its size or revertability, commit or branch hygiene, a PR marker. No recipe can execute them. Today every AC registers as a recipe claim with proof mode `state`, `visual` or `mixed`. Such a criterion either ends `missing` ("A required executed expectation is missing.") or waits for a visual judgment that never comes. Either way the claim-verdict policy blocks publication even after the code review has passed, and the evidence tab reads as if the agent did not deliver. Four held validation runs show exactly this: their criteria "the change is minimal and easy to revert" and "the branch or PR is marked DO NOT MERGE" block publication, although each run's code review passed at the gate head.

### Decision

1. **Mode.** Add a fourth proof mode, `review`: the criterion is checked by the run's code review, not by the recipe. It is declared like the other modes, in a recipe's `proofTargets[].proofMode`. Planning rejects any recipe node that `proves` a `review` claim.
2. **Engine verdict.** The engine records a `review` claim as `awaiting-review` with no recipe nodes. It is never `missing`.
3. **The review sees it.** The gateway appends the run's `review` criteria to every code review request, as a template-independent section like the description pre-check. The reviewer reports any unmet criterion as a finding.
4. **Gate.** A `review` claim is satisfied only when the gate's own publication-review prerequisite is met at the package head: the required passing reviews, and no open findings at that head. This is the existing publication-review blocking check, not merely one passing session. A new head, a failing review or an open finding makes it unsatisfied again. For inherited acceptance (Amendment 12) the head is the approved parent package's head. A run with no publication review cannot satisfy a `review` claim, and worker completion refuses one there with a message that says so.
5. **One owner.** Satisfaction is applied inside claim derivation, through the review authority that already carries visual receipts. Parent claims re-aggregate, and the gateway and both clients share one computation. No new verdict writer, receipt or store is added.
6. **Display.** A satisfied `review` claim reads "Checked in review" and an unsatisfied one "Awaiting code review", never "missing". The same labels appear on the claim rows and on the surfaces that print a raw verdict: the CC evidence preview, the Companion evidence workspace and progress view, and the recipe coverage summary.
7. **Who marks it.** The worker sets the mode when it writes the recipe's claim declarations. The execution templates add one rule: a criterion about the change itself (diff size, revertability, commits, branch, or PR title or labels) gets `review`, and anything observable in the running product keeps `state`, `visual` or `mixed`. There is no per-AC rule engine and no text classifier in code.
8. **One projected status.** `run.get`, `decision.list`, Command Center and Companion show the gate's projected acceptance: receipts, authorized overrides and satisfied `review` claims merged over the engine ledger. The acceptance contract carries both the projected and the engine verdict, and the projection is kept when the gate resolves. Today it is computed for readiness and then discarded, so a criterion with a confirmed visual receipt still shows `awaiting-review`.

### Rationale and consequences

A code review already certifies the exact package head before publication. Showing it the criteria that only a review can judge, and counting them only when that review is clean at that head, adds no new authority and no new evidence store. It also stops those criteria being mislabelled as missing proof. Amendment 3's attested approval does not cover this case: it needs a person for every run, and it waives a finding rather than proving the criterion. An `untestable` override (Amendment 4) still means "could not be tested", never "proven". Runtime criteria are unaffected, and gate acknowledgment still never substitutes for an eligible assertion or visual judgment.

### Public surface and migration

- **Protocol:**
  - `RecipeClaimProofMode` and its validation gain `review`, as do the recipe-v1 schema enum and the acceptance-ledger mode list.
  - The ready-gate acceptance contract carries the projected verdict next to the engine verdict.
- **Packages:** recipe-runner planning and claim derivation, the review request builder, the gateway's claim-verdict evaluation, the evidence-review authority and the shared claim labels change. Execution templates gain one instruction line.
- **Held runs:** runs already held keep their frozen declarations. Their status is re-projected through point 8, so a claim with a confirmed visual receipt shows as confirmed, and the other claims show as their recipe declared them. They gain no review satisfaction after the fact: an AC declared `state` or `mixed` keeps blocking until a new run declares it `review`. The held validation runs are re-run with the updated templates to prove the path.
- **Tests:**
  - A `review` claim is satisfied at a clean reviewed head.
  - It blocks at a different head, with an open finding, after a pass is replaced by a failure, or when the review comes from a non-qualifying session.
  - Planning refuses `proves` on a `review` claim.
  - A confirmed receipt reads as proven in `run.get` while keeping its engine verdict.

## Amendment 19 (2026-10-24): Publish captures from same-run attempts at one head

**Status:** Accepted (2026-10-27).
**Specification:** [Consumers and publication](../reference/recorded-run-evidence.md#consumers-and-publication).

### Decision

One publication package may include after and standalone captures from several
recipe attempts captured by the same run at its clean publication head. Each
attempt keeps its original path, execution identity and complete immutable
closure. Admission and frozen readers check the run's captured inventory,
product provenance and every consumed byte. Before captures use the frozen full-review
base when available, otherwise the run's dispatch baseline. A warm review delta is
not a full-review base; replaying dispatch must not invalidate the recorded comparison.

The successful-attempt pointer still selects claim verdicts. Additional captures
do not combine ledgers, borrow passing sibling verdicts or qualify visual claims
from another execution. Cross-head claim retention remains Amendment 10's
separate repair contract. No new pointer, package format or public RPC is added.

### Rationale and consequences

A network change or application restart needs a fresh recipe attempt, while its
captures may document the same code revision. Restricting publication media to
one attempt rejects valid proof without adding source integrity. This amendment
chooses several attempts per publication package for session-persistence proof:
retain the recorded write and the relaunched session's assertion of the same
value. Recording remains bound to each original session. Several checked
closures can share the existing publication package and approval hash. Missing,
foreign, dirty, stale-head or changed closures still refuse, and all selected
closures retain the existing secret scan and publication approval requirements.

## Amendment 20: derived acceptance for PR completion, 2026-10-23

**Status:** Accepted. Lead approved proposal `31435dc1` as Amendment 19 on 2026-10-25. Renumbered to 20 because main independently assigned 19 to multi-attempt captures.
**Specification:** [PR-completion acceptance registration](../reference/recorded-run-evidence.md#pr-completion-acceptance-registration).

### Decision

A `pr-complete` run records the original PR's parent-run or linked ticket criteria as evidence only; they never block completion. A first derive-acceptance subtask adds one criterion per unresolved actionable review comment, linked to its source, and one per extra operator instruction. Derivation is enabled only when the selected `pr-complete.md` or interactive template declares that subtask. Authenticated interactive steers can append obligations through the same registration owner.

The engine registers proposals in the existing acceptance registry and ledger projection. Original IDs and order stay fixed; new IDs append. Retries are idempotent by source identity. Neither a template nor a worker can replace the original criteria or write authoritative verdicts. ADR-055 owns comment intake; task init freezes its authoritative completion snapshot for every entry point, including review bots. The retained worker classifies comments and instructions, and engine validation enforces snapshot coverage. ADR-060 owns the subtask lifecycle.

Original criteria keep their recorded provenance and verdicts. Derived review-comment and operator requirements retain checks the worker can satisfy. Evidence-only criteria are never stamped as proven merely to finish the run.

PR completion MUST NOT wait for a reviewer or person. The captured visual-proof hold and conditional REVIEW step are removed as of 2026-10-28. Linked criteria, captures and unassessed claims remain evidence; completion does not qualify visual judgments. Worker-owned checks for derived requirements, deterministic checks, report contracts and pushed-head identity remain in force.

The registration revision participates in completion and gate identity. New instructions cannot leave an earlier ready decision valid. Frozen task inputs, parent evidence and previous gate snapshots remain immutable. Command Center and Companion consume the same registered list, provenance and verdict projection.

### Rationale and consequences

Registration keeps ticket criteria, review fixes and operator obligations visible. A captured visual-review hold stranded a PR-completion run on an empty review screen. PR completion records that evidence without adding a review decision.

Extend the shared protocol and existing registry, contract resolver, completion guard and client presentation. Do not add a second ledger, verdict writer or client-specific acceptance model. Existing runs keep their selected template and frozen contract until an explicit supported migration. F194 authorizes normal COMPLETE replay after deployment for the affected held run; no operator review acknowledgement is required.

### Public surface and delivery

- `@farmslot/protocol` 0.71.0 owns `AcceptanceRegistration`, source-linked criteria, typed derivation results and acceptance input revisions on `Run`. `registeredAcceptanceCriteria` and `acceptanceCriteriaView` retain the original list and project accepted appends.
- `@farmslot/agent-runtime` 0.39.0 owns `mark sub <id> complete --acceptance-result <path>`. Its child stays running until the gateway persists the validated result and returns an acknowledgement. `farmslot-agent ac` remains read-only.
- A PR-completion template declares `firstSubtask: derive-acceptance`. Task init records that declaration and requires a gateway-owned, capable handoff. The initial child owns `CHECKLIST.md` step 1.
- `terminal.send.operatorMessageId` names a retry-stable authenticated instruction. Native worker sends retain their existing `commandId`. Both enter the same registration owner; ordinary input on opted-out templates adds no derivation unit.
- New PR-completion runs receive capability version 1. The gateway selects immutable `inputs/acceptance-contracts/<revision>.json` records through `inputs/acceptance-contract.json`, confirms node delivery, and leaves the original terminal contract unchanged. The runtime refuses unsupported versions or stale modes. Existing comparison/eval review exclusions remain explicit unsupported destinations, never mode downgrades.
- `@farmslot/review-dispatch` 0.19.0 extends the existing acceptance presentation for both clients. Source links, exclusions, pending instructions and inherited proof use that shared projection.

Release the protocol, runtime and shared consumers before opting project templates in. Existing runs and selected pins retain their contracts. This amendment adds no project, harness, network or deployment default.

## Amendment 21 (2026-10-31): Operator-attested before attempts

**Status:** Accepted (lead, 2026-10-31). F276.
**Specification:** [Consumers and publication](../reference/recorded-run-evidence.md#consumers-and-publication).

### Decision

Some before sides cannot be recorded clean at the publication baseline, for
example when the recipe needs files the change adds. At an unresolved publish
gate, a credential-backed person may attest one recipe attempt captured by the
same run, `artifacts/recipe-runs/<recipeRunId>/`, as before-only evidence, with
a written reason.

The gateway records the attestation on the Run, never in task or recipe files:
attempt root, the sha256 of its `artifact-manifest.json`, decision id, reason,
approver and time. When the gate shows a package, the attestation commits only
against the package hash the operator was shown. The record does not keep that
hash, because admitting the before side changes it. Admission then accepts that
attempt's before-only declarations without the baseline `git_ref`/`dirty`/`branch`
match. Ownership, captured digests, closure, secret scan and publication
approval still apply. After and standalone evidence still require the clean
selected head.

The attestation applies only while the attempt's manifest digest matches. Any
change to the attempt needs a new attestation. It resolves no gate; the operator
retries the gate to rebuild the package. The package binds the admitted
attestation ids, so a later attestation needs approval again. It never satisfies
or changes a claim verdict. PR evidence labels that before side "Before: operator-attested" with
the reason, actor and time. Run-bundle import drops attestations, as it drops
claim override receipts.

### Rationale and consequences

Amendment 19 keeps before captures honest by binding them to the unchanged
baseline. Without an exception path, a change whose recipe depends on its own
files can only publish with no before side, or the worker has to fake a clean
baseline. The attestation reuses the untestable-override receipt model
(Amendment 4): a gateway-owned, person-backed receipt bound to content digests.
No new package format or evidence pointer is added. The attestation is
disclosed wherever the before side is shown. Admission compares the manifest
digest the ownership walk already computes; recording reads one manifest from
the run's checkout.

### Public surface

`run.attestBeforeAttempt` (`RunAttestBeforeAttemptParams`: `runId`,
`decisionId`, `recipeRunId`, `reason`, optional `packageHash`) and
`Run.beforeAttemptAttestations` in `@farmslot/protocol`. The shared gate action
`attest-before-attempt` routes to it, and `farmslot run gate <runId> --action
attest-before-attempt --recipe-run <id> --reason <text>` is the CLI surface.
