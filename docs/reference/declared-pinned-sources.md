# Declared and pinned sources

**Status:** Accepted normative specification for [ADR-069](../adr/069-declared-pinned-sources.md).
**Approved by:** Arthur, 2026-10-12
**Owner:** Arthur / Farmslot
**Lifecycle:** Maintain with the accepted contract; implementation is approved in three staged PRs.

MUST, MUST NOT and MAY are normative. The contracts below are accepted; release requires reviewed implementation.

## Authority and records

The gateway MUST be the sole resolver of declared pack, recipe-library and
helper-repository refs. Nodes MUST consume exact commits, never independently
follow refs. Source configuration MUST belong to the gateway's farm configuration,
outside the materialized pack it bootstraps. It MUST include every transitive
source dependency used by a selected execution; undeclared imports MUST fail.

| Record                  | Required facts                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SourceDeclaration`     | Stable `id`, `kind` of `pack`, `recipe-library` or `helper`, credential-free `repo`, `ref` defaulting to `main`.                                                                                   |
| `SourcePin`             | Source ID, selection of experiment branch or explicit main override, ref, scope and target ID, actor, declaration revision, base main commit, creation time.                                       |
| `SourceResolution`      | Source ID, effective ref, declaration revision, independently increasing generation, exact fetched commit, last successful resolution and current resolved/stale/failed status.                    |
| `SourceLock`            | Schema version, admission context, generation within that context, canonical digest, declaration/pin revisions, resolution time and complete selected-closure entries with resolution generations. |
| Lock entry              | Source ID/kind/repository, declared and effective refs, exact Git object ID and object format, selected scope, pin context and dependency closure.                                                 |
| Materialization receipt | Execution node or gateway identity, lock digest, source commits, verified tree digests, protection result and verification time.                                                                   |
| Run provenance          | Attempt identity, lock digest and immutable lock entries, materialization receipt IDs and consumed pack/library/helper bindings.                                                                   |

Repository identity MUST be canonicalized consistently across authentication,
locks and caches. Credentials, local checkout paths and embedded URL credentials
MUST NOT appear in these records. Repository-relative consumer entry paths MUST
be contained in their declared source. Source declarations confer no executable
trust beyond ADR-068's existing authorization.

Locked pack/library declarations MUST identify dependencies by source ID and
contained relative entry. The resolver MUST build their closure without running
source code, rejecting missing IDs, cycles and incompatible bindings. A new pack
revision referencing an undeclared helper MUST fail before publication/admission.
Git submodules and large-file objects required by a source MUST also be declared
and verified; a commit alone MUST NOT conceal unresolved external inputs.

Locks MUST preserve full Git object IDs with their object format. A lock digest
MUST cover canonical content including repository identity, commits, dependencies
and effective pin context. Unknown fields that change execution semantics MUST
require a schema version transition, not be ignored by an older node.

## Resolution and branch updates

Resolution records MUST be maintained independently for each source ID/effective
ref/declaration revision. A failed record MAY retain its last verified commit in
cache, but MUST be marked failed or stale and MUST NOT be used in a new lock.
A source lock MUST be composed for one admission context: selected run inputs
over node selections over farm selections, restricted to the selected closure.
There is no single farm-wide generation whose publication waits on unrelated
repositories. All entries in a new effective lock MUST be current and verified.

The gateway MUST resolve and fetch every required commit before publishing a new
lock generation. Publication MUST be atomic for the dependency closure. Failure
of any required source MUST leave the prior complete lock intact and expose the
failed source; it MUST NOT silently admit work under that older generation.
An unrelated source's failure MUST NOT prevent work whose complete closure is
current and verified.

Branch refs, including pinned experiment branches, MUST be re-resolved
automatically. Each successful observed advance MUST create a new generation.
An admitted run MUST retain its prior generation. Tags and full commit refs MUST
resolve to fixed commits; moving a tag MUST be reported as a ref rewrite and
require an explicit declaration revision before adoption.

A force-pushed branch MUST resolve to its newly observed commit after complete
fetch and validation, with an audited `ref-rewritten` transition containing old
and new commits. Automatic tracking MUST NOT rewrite existing run provenance or
delete referenced old objects. An unavailable new commit MUST refuse new
admission. An unavailable old commit MUST refuse only work/replay requiring that
old lock; another branch or a nearby commit is never a substitute.

The resolver MUST define a bounded polling/reconciliation interval and expose
last successful resolution, pending updates and failures. A selected closure
with an overdue or failed resolution MUST be reported stale and refuse new
admission until reconciled. The interval is farm operational policy, not a
per-source execution override. Explicit sync MUST use the same resolver.

## Scoped branch pins

Pins MUST accept only pushed branch refs in an authorized declared repository.
They MUST reject local paths, file remotes, dirty snapshots, unresolved refs and
undeclared repository replacement. Scope is exactly one run, one node or the farm.
Run scope wins over node scope, which wins over farm scope, for each source.

Every pin MUST retain the base main commit observed when it was created. Status,
run detail, dispatch selection and node views MUST show branch, exact resolved
commit, base commit, scope and any shadowed broader pins. Changing the branch
creates a new pin revision; automatic branch advances preserve the original base.

Unpin MUST select main at the requested scope. If a broader pin exists, a main
override MUST persist at the narrower scope so that the broader experiment
cannot become effective silently. Status MUST show that override and broader
pin. Removing a farm pin returns the farm default to main, retaining a main
override if the declaration uses another ref. Once broader pins
are removed, redundant main overrides MAY be collected without changing behavior.

Pin/unpin MUST be serialized with admission, require the current declaration/pin
revision and preserve actor/time audit. Retried mutations MUST use the existing
RPC operation identity and return the original result rather than apply twice.
Conflicting revision or changed scope ownership MUST return a stale-state error.

A run pin MAY change only while that run has no admitted execution attempt and
no source-dependent effects. A queued run MUST be replanned and revalidated
against the new closure before admission. Run creation MUST support the same
run-scoped selections atomically in its request, so immediate dispatch does not
race a later pin command. Active and historical attempt inputs MUST NOT change;
experiments on those inputs require a new run. Run pins cannot escape to siblings.

## Materialization and admission

Gateway and nodes MUST materialize a lock into content-addressed, separate
generations. They MUST fetch into staging, verify object/tree identity and the
complete closure, establish write protection, then publish a receipt atomically.
Interrupted fetch, missing objects, invalid entry paths or failed protection MUST
leave no usable partial generation. Git fetch/checkout MUST NOT run repository
hooks, provider imports or dependency-install scripts as part of resolution.

Run admission MUST freeze a complete lock before reading executable pack config,
selecting library recipes or running helper code. The gateway MUST validate the
plan and source trust from those locked inputs. The selected execution node MUST
attest the same digest and actual commits immediately before source-dependent
prepare or dispatch, including slot-free workspaces. A concurrent pin/update
MUST either precede that freeze or affect future work, never a half-old plan.
Read-only planning MAY inspect a provisional complete lock without executing
source code. Admission MUST revalidate it; preview does not establish a run receipt.

Write protection MUST prevent worker/provider processes from modifying source
trees, including untracked files, symlink escapes and Git metadata. A writable
checkout with an advisory read-only label or removable mode bits is insufficient.
Install/build caches, runtime settings and scratch/output files MUST use separate
writable roots keyed where necessary by source and dependency identity. Per-node
values MUST remain pool placeholders; they MUST NOT be committed into materializations.

Consumers MUST resolve source IDs through one shared binding resolver, with
repository-relative entry paths. No loose checkout or deployment-copy fallback
is allowed. Changes to pack/library/helper inputs MUST preserve existing library
precedence, qualified references and dependency authorization under ADR-068.

Node status MUST report node-scope effective lock digests for eligible closures,
the composed lock digest per admitted run, actual source commits,
protection/integrity results and drift reasons. Missing reports, a modified tree,
substituted repository, missing commit or mismatched lock MUST refuse new work.
An older generation intentionally retained by an active run is not undeclared
drift, but it cannot substitute for the generation required by a new run.

Drift during an admitted run MUST prevent further source-dependent actions until
the admitted generation is verified again. Recovery MUST preserve existing worker,
resource and artifact ownership under ADR-065, and MUST NOT kill foreign work or
claim `blocked` while work is confirmed active. Automatic branch updates MUST NOT
replace, restart or unmount active inputs.

## Failure and retention rules

| Failure                                                    | Required behavior                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway offline or node disconnected                       | No new admission, pin change or ref advance without gateway authority. An already admitted run MAY continue on its verified retained inputs under existing ownership rules.                                                                       |
| Authentication denied or expired                           | Report the affected source and safe credential-reference diagnostic; refuse its closure. Reuse existing per-repository credential handling, never try another repository identity or expose tokens.                                               |
| Private repository                                         | Gateway resolution and node materialization MUST each have authorized access or use a gateway-delivered, digest-verified Git-object bundle bound to the authorized lock. Never publish private object content or credentials to public artifacts. |
| Branch deleted/force-pushed; commit no longer fetchable    | Report the exact missing object/ref and preserve old run locks. Use retained verified objects where available; otherwise refuse, with no ref or commit fallback.                                                                                  |
| Partial fetch or lost acknowledgement                      | Preserve the prior complete generation. Reconcile the operation ID and receipt before retry; no partial source set is eligible.                                                                                                                   |
| Invalid configuration, unsupported schema or unknown drift | Expose the reason and refuse affected admission rather than infer defaults or report clean.                                                                                                                                                       |

Retained objects for deleted or unfetchable refs MUST serve only already-locked
work and replay. New admission on that ref MUST refuse and status MUST show it
as dangling. Later attempts of an admitted run MUST reuse its frozen lock and
refuse when exact retained inputs are missing.

Source locks and receipts referenced by retained runs/evidence MUST be retained
with their provenance under ADR-062. Objects/materializations needed by active
work MUST NOT be collected. A replay requiring missing exact inputs MUST report
them; retention expiry never permits replay against today's main. Historical
records lacking commits MUST retain raw provenance and an explicit unknown state.
Repository/ref metadata and object content MAY be private. Authenticated status
and bundle access MUST respect existing repository permissions. Public evidence
exports MUST follow ADR-062's publication authority and retain opaque provenance
references when source metadata is not authorized for publication.

## Public surface

The single CLI adds these commands; existing connection/auth and `--json` options
are reused. No separate recipe CLI, deployment command or source-sync binary is added.

| CLI                                                                                   | Consumer and semantics                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farmslot sources status [sourceId] [--run runId \| --node nodeId]`                   | Operators and diagnostics inspect declared/effective refs, pin/base, generations, actual commits and drift. No selector means farm view. Read-only.                                     |
| `farmslot sources sync [sourceId] [--node nodeId]`                                    | Operators reconcile the gateway lock and materialize the selected node, or required farm nodes when omitted. Existing admitted inputs stay intact. Reports per-source/per-node results. |
| `farmslot sources pin sourceId --ref branch (--run runId \| --node nodeId \| --farm)` | Operators configure exactly one explicit scope. The CLI captures current revisions and uses the same mutation contract as dispatch clients.                                             |
| `farmslot sources unpin sourceId (--run runId \| --node nodeId \| --farm)`            | Operators return that scope to main, with the visible override rule above.                                                                                                              |

The gateway exposes `sources.status`, `sources.sync`, `sources.pin` and
`sources.unpin`. Mutations MUST enforce existing repository/target authorization,
scope ownership, operation identity and expected revisions. Sync may fetch and
materialize; it MUST NOT restart services, execute project hooks or grant leases.
Read-only status MUST NOT fetch, acknowledge or repair sources.

`@farmslot/protocol` owns accepted exports `SourceDeclaration`, `SourcePin`,
`SourceResolution`, `SourceLock`, `SourceMaterializationReceipt`, `RunSourceProvenance`, typed
`SourcesStatusParams/Result`, `SourcesSyncParams/Result`,
`SourcesPinParams/Result`, `SourcesUnpinParams/Result`, `SourceStatusViewModel`,
`deriveSourceStatusView` and `validateSourceSelection`. Gateway/node RPCs,
existing gateway clients, CLI, Command Center and Companion consume them.
Run-creation DTOs gain `sourceSelections`, consumed by dispatch clients for atomic
run-scoped selection before immediate admission. No SDK may
resolve refs or approve drift independently of the gateway.

`@farmslot/slot-config` owns accepted `SourceBinding` and `resolveSourceBinding`,
consumed by gateway pack loading, node hook expansion, recipe-library resolution
and helper/provider loading. Bindings contain execution-local roots derived from
verified materializations; callers cannot supply arbitrary filesystem roots.
Harnesses consume these bindings and inherit admission and provenance.

One context-aware source picker/status component and one shared view-model MUST
serve farm, node, dispatch and run views. Lit and React Native renderers are thin;
allowed actions, scopes and defaults come from call context and gateway authority.
Neither platform duplicates validation, pin precedence or drift derivation.

Locks/receipts use schema version 1 when implemented. Additive compatible DTO
fields require coordinated protocol/client releases; incompatible semantics
require a schema transition and a breaking package release under repository
version policy. Unsupported peers MUST refuse admission. Accepted exports are
not stable APIs until the reviewed implementation release ships.

## Live source status

**Status:** Accepted (2026-10-17, lead-approved) with [ADR-069 Amendment 1](../adr/069-declared-pinned-sources.md#amendment-1-2026-10-17-live-source-status).
This is the pilot slice of ADR-071 (gateway change notifications, proposed and
not yet published).

### Signal

The gateway MUST publish a `ResourceChangedPayload` with `version: 1`, an `epoch`
and `changes`. `epoch` is an opaque identity created at gateway process start.
`changes` MUST contain `{ key: { family: 'sources', scope: 'farm' }, revision, kind: 'updated' }`.
The revision is a nonnegative safe integer that only increases within an epoch;
clients MUST NOT compare revisions across epochs. The key is a broad farm scope:
every source context depends on it. The payload omits credentials, paths, source
IDs and pin contents.

The revision MUST advance after any of these changes becomes readable through
`sources.status`: a declaration load or change, a pin or unpin including pins
created with a run, a resolution status, commit or generation change, a persisted
lock, a run source plan or provenance write, a run transition that ends its pin
selection, an execution node connecting or disconnecting, a sync completed through
the gateway, and a node's first receipt for a lock. A resolution refresh that
changes only `resolvedAt` MUST NOT advance it. Node receipts and drift that a node
reports only when `sources.status` asks remain current as of that read and show
their verification time.

`hello` MUST carry the current payload as `resourceChanges` when sources are
configured, that is when `sources.status` reports `configured: true`. Until ADR-071
is accepted, every `fleet.updated` from such a gateway MUST carry it too, and each
revision advance MUST broadcast `fleet.updated` with the current fleet. The gateway
MAY attach the payload at one point for every `hello` and `fleet.updated` send. The
payload MUST reach only principals that may read
`sources.status`; events delivered to other principals, such as `run.*`, MUST NOT
carry it. Duplicate and older revisions are harmless.

### Client behavior

The shared source status controller MUST reread `sources.status` for its current
context when the published revision exceeds the highest revision it has seen,
when the epoch differs from the last one seen and after every reconnect. It MUST
ignore duplicate and older revisions. A change observed while a read is in
flight MUST schedule one more read after it. A change observed while a failed
read is shown MUST reread. Panels MUST NOT poll or offer Refresh. A failed read
MUST stay visible with Retry.

If sources are configured and the connection's `hello` had no
`resourceChanges`, the panel MUST show that live source status is unsupported
by the gateway, keep its last read and reread only after reconnect.

### Panel

A source panel MUST render nothing when its context has no declared sources, no
pins and no recorded run inputs, or when the viewer cannot read `sources.status`.
Otherwise it MUST show one line naming each source's effective ref, with branch
and scope for pins. Errors from `sources.status` MUST stay visible. Resolved and
base commits, shadowed pins, locks and node receipts sit behind a one-line
toggle, which satisfies the view requirements in Scoped branch pins. The panel
MUST NOT repeat the run ID or add explanatory text for read-only contexts. Pin
controls remain where the context allows them.

### Acceptance

- A pin or unpin made by another client appears in an open panel without user
  action, in both clients.
- A run admission and a sync started from another client appear in an open
  panel.
- An unconfigured, unpinned context renders nothing.
- A change made while disconnected appears after reconnect.
- A gateway without the signal shows the unsupported state.
- Evidence includes light and dark screenshots.

## Migration and acceptance

The implementation MUST inventory consumers privately, then publish portable
old-to-new mappings and verify each retained behavior before deleting its old path.

| Existing input or mechanism                                | Required destination / proof                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway pack checkouts and in-place overrides              | Upstream clean source commits plus declared pack bindings; compare loaded config, templates and hooks at the same commit.                                           |
| Deployment pack rsync in `scripts/deploy-node.sh`          | Gateway lock delivery and node materialization; verify every previously copied config/setup/helper consumer before deleting the pack loop. Keep service deployment. |
| Loose recipe-library checkouts and absolute pool roots     | Declared library IDs and locked binding resolution; preserve qualified refs, precedence, dependency closure and executable trust.                                   |
| Helper repositories and hook entry paths                   | Declared helper IDs and contained relative entries; prove existing arguments, placeholder expansion and teardown against the locked tree.                           |
| On-disk schema migrations                                  | Upstream migration PR or versioned load-time conversion; prove materialized bytes remain identical.                                                                 |
| Stale node project copies and operator source-sync scripts | Delete after all consumers use lock receipts and new admission passes. No compatibility shim or fallback remains.                                                   |

Roll out declarations and verified materialization before enabling admission.
Active legacy runs MUST finish against retained old inputs and be labeled legacy
with their actual available provenance. They MUST NOT be relabeled as lock-admitted.
After draining them, enable fail-closed admission, verify all eligible nodes, then
delete superseded copies and scripts. Preserve operator changes upstream first;
never overwrite them as cleanup.

Acceptance MUST prove branch auto-advance without changing an active run; all
pin scopes and precedence; unpin-to-main under broader pins; admission/pin races;
force-push provenance and missing-object refusal; auth/private-source handling;
offline and partial-fetch refusal; real write protection; undeclared drift;
source-complete replay; shared client projections; and consumer-by-consumer
migration parity. Regression tests MUST be bounded; live fleet proofs remain
separate. This docs-only acceptance performs none of the migration or deletion.
