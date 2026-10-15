# Retained run artifacts

Status: Accepted by the lead, 2026-10-15, [ADR-039 Amendment 1](../adr/039-run-portable-bundles.md#amendment-1-2026-10-15-gateway-retained-run-artifacts).
This is the canonical retention/read contract, not a second evidence format.
It extends [ADR-062](../adr/062-recorded-run-evidence.md)'s existing reader and review authority.

## Capture and storage

The gateway MUST retain produced reports and artifacts at completion, output
review and publication-package preparation. Acquisition reuses the existing
artifact inventory/transfer producer and its run, task, execution and generation
checks. Explicit refresh operations invoke this same producer. A viewer MUST NOT
initiate remote collection or silently refresh history.

Capture the report, output inventory, selected recipe closures, selected QA
registrations, baseline comparison dependencies and their referenced screenshots,
video, timelines, ledgers and manifests. Preserve their bytes and logical paths.
Do not scan or copy an entire repository, credentials store or unrelated attempt.
The existing canonical reader and validator still determine package completeness
and proof; retention itself grants neither.

Use the existing `RunBundleManifest` v1 and logical layout:

```text
FARMSLOT_HOME/run-bundles/sha256/<bundle-digest>/
  manifest.json
  runs/<run-id>.json
  tasks/<task-key>/...                 # captured task-relative files
  packages/...                        # when already present
  analytics/...                       # existing full-profile export only
```

The owning Run store binds its bundle root once to
`<owner FARMSLOT_HOME>/run-bundles` in durable Run-store metadata. All readers,
capture writers and GC resolve that same binding, keyed by the canonical Run
store, including when `FARMSLOT_RUNS_DIR` is shared. A sandbox's isolated
authentication home MUST NOT establish or replace that binding. A missing or
mismatched store pairing refuses capture, reference writes and GC, leaving the
owner's history untouched. Read-only sharing uses the owner's bound store;
private validation uses an isolated Run store and imported references.

The digest is SHA-256 of the exact stored `manifest.json` bytes. Existing manifest
entries bind each relative payload path, SHA-256 and byte size. The digest names
the original capture; later pruning changes availability, never its manifest or
retained bytes. A manifest entry does not assert that pruned media still exists.
`runs/` contains a
sanitized capture-time record; the existing Run store remains lifecycle authority.
For retained captures, `profile` is `reference`, `remapPolicy` is `preserve-ids`,
and `source.farmslotRoot` identifies the owning gateway root for provenance only.
No reader resolves artifact files through that informational source path.
No object database, alternate manifest or per-client package parser is introduced.

Stage under the same gateway home, enforce path containment and byte budgets,
stream-copy/hash files, then publish by atomic rename. Fence the Run reference
update against the captured run/task/generation. A concurrent successor or failed
copy MUST NOT replace a committed reference. A retry finds the committed capture through its persisted Run-store capture intent
and reference, reusing its original manifest bytes, `bundleId` and `exportedAt`.
It MUST NOT generate a new timestamp/UUID for the same intent. One store-scoped
lock serializes capacity reservation, publish/reference commit and GC; the new
bundle remains capture-pinned through the rename/reference-update window.
Staging and retained entries MUST NOT be writable through artifact readers.

The existing mutable artifact mirror is acquisition staging, not a retained read
source. Materialize from its captured inventory and selected closures. Charge
staging/mirror bytes to the same storage budget; after commit, release redundant
gateway media copies. Keep operational task inputs and source-slot files intact.
Footprint ownership counts physical copies once, as ADR-062 requires.

Missing files or differences from a historical inventory are recorded through
existing manifest `missingData` and the capture result. A partial capture is never
presented as a complete evidence closure. An available retained report remains
readable with that limitation; package integrity failures remain non-waivable.

## References and readers

Protocol owns `RunArtifactBundleRef`, containing the owning store identity,
bundle digest, task key and source output-inventory `manifestDigest`. That source
identity matches historical output reviews without rewriting their receipts;
changed source bytes retain a mismatch warning rather than a fabricated match.
Run output and prepared publication packages carry their capture's reference;
output decisions, review receipts and attestations bind that digest through their
existing snapshot identity. An optional current reference may advance only after
explicit new capture. Previously reviewed references MUST remain unchanged.
Mark-reviewed, archival and other metadata-only transitions MUST NOT recapture,
repoint, or rewrite report/evidence bytes.

Every artifact consumer MUST resolve from the referenced gateway bundle:

- `run.recipeRunsForRun`, report loading, artifact listing and HTTP file/range reads;
- Command Center, Companion and CLI inspection;
- `verifyRunOutputReview`, prerequisite/publication selection, descriptions and export;
- recorded-evidence acquisition feeding the existing SDK reader/model/validator.

A request carrying a gate/review identity MUST use that identity's pinned bundle,
not the Run's latest reference. Historical links retain their digest. Cross-run
or unknown references MUST be refused using the existing authorization boundary.
A run without retained bytes reports retention missing and the supported recovery
action. It MUST NOT fall back to a live slot, including when the node is online.
Before a capture exists, an in-flight run may keep its existing live operational
monitoring/progress transport. This does not make a report or artifact viewer a
slot reader: retained reads show pending capture until bytes are retained.

Use the verified local manifest as the listing/index. Immutable metadata may be
cached by bundle digest, with concurrent identical reads coalesced. Ordinary
reads MUST NOT walk a task tree, transfer node files, unpack `.farmrun`, or hash
all video to open a report. Media range serving and current transcode policy stay.
Report open must render the retained report in under two seconds on the target
operator setup, including the first read after gateway restart.

## Report availability and review validity

Read report MUST open an available bundled report read-only even if its prior
review binding is stale, incomplete or missing. Show the retained digest and a
clear warning that the bytes are not the reviewed snapshot. Preserve the prior
expected digest when known. Do not silently substitute another report or mark
it reviewed. Missing report bytes still produce an honest unavailable result.

This display allowance MUST NOT waive package integrity, claim/execution/QA
binding, visual judgment, attestation or publication policy. Report access cannot
resolve a decision or become a verdict. The shared SDK model/source adapter owns
this distinction for both clients; there is no client-specific exception mapping.

## Limits, retention and GC

Gateway-owned `runBundleRetention.maxBundleBytes` defaults to 2 GiB and
`maxStoreBytes` to 20 GiB, measured on materialized payload plus manifest bytes.
A protected `metadataReserveBytes` defaults to 512 MiB within that total. Reserve
mandatory report/lightweight-metadata capacity before admitting work/capture;
media MUST NOT consume that reservation. Count in-progress copy reservations and
mirror staging in the same budget. Recorder/transcode limits stay unchanged.

Capture and commit the report, manifests, ledger, trace/timeline and review
metadata before media admission. Media quota exhaustion MUST NOT discard or hide
a produced report: commit the available report/metadata with explicit missing
media, then retry media capture after capacity recovery. A protected-metadata
reservation failure refuses admission before new work can rely on that capacity;
it never evicts an existing report. Historical backfill also retains its report
before attempting bulk media. Missing media grants no proof or publication waiver.

Apply ADR-062's existing separate lifetimes. Run history pins the report and
lightweight frozen metadata for its lifetime, not every media payload. Unresolved
gates and required published references pin their media dependency closures.
Unpinned completed media defaults to 30-day retention, overridable by Storage
policy. Storage may prune eligible media without changing the immutable manifest,
recorded verdicts or ranges. Availability and retention revision MUST separately
record `pruned`; readers do not claim that those payload bytes still exist.
Complete export/publication cannot pass missing required media off as complete;
reuse the existing missing-data/refusal rules, without re-reading a source slot.

GC rechecks all existing dependency pins and the owning store binding under the
same commit lock. It may delete wholly unreferenced bundles, eligible unpinned
media, and abandoned staging older than 24 hours. It MUST preserve active capture
reservations and history metadata. Deleting one Run does not delete objects
referenced elsewhere. After retention changes, update the existing Storage
footprint/availability projection; do not create a separate statistics store.

If GC cannot make room for media, report explicit capacity/missing-media status
while the report remains readable. Do not truncate video, silently drop selected
files, or evict pinned snapshots to admit a new capture. Operators can change the
server-owned limits or release history/pins through existing lifecycle operations.

## Public surface and backfill

The experimental public command is:

```sh
farmslot runs bundle retain <runId>
```

`@farmslot/cli` invokes the authenticated `run.bundle.retain` RPC. It uses the
existing run/artifact authorization boundary, accepts a run identity rather than
an actor or destination path, and writes only below gateway-owned retention.
`@farmslot/run-bundle` adds experimental `materializeRunBundle` and
`resolveRunBundleEntry` exports for gateway capture, HTTP reads and export.
They reuse its existing codec, hashing and manifest validation. Protocol owns bundle
references, request/result types, and `decisionArtifactBundleRef`, the shared
decision-snapshot selector used by gateway readers and bundle GC. Existing SDK evidence exports remain the
single evidence model, consumed by both clients and publication.

The command backfills done/failed runs from their existing captured inventory and
still-available task/slot source. It returns the retained digest and explicit
missing/changed-data details. Repeating a successful backfill is idempotent and
requires no node read once the referenced bundle is complete. It does not remap a
run, change source, rerun a recipe, alter registration/claims, resolve a gate or
rewrite an earlier review. It cannot recover bytes already lost before capture.

Changed historical bytes may be retained as an explicitly unverified available
snapshot, preserving the original expected digest and warning. They MUST NOT
replace or satisfy the prior review binding. Export/import remain farmrun v1;
private retention does not bypass existing public-export sanitization or checks.
Protocol/CLI changes use normal additive versioning; `@farmslot/run-bundle` is a
private workspace package. Worker-loaded consumers, if changed, must be released
and verified installed before rollout claims. Seed, reference-only and mirror
imports must materialize target-owned retained references before removing the
unpacked archive; imported references never keep a source-store root binding.

## Required verification

- Change/reuse or disconnect the source slot after capture and review: the same
  report and evidence remain readable with unchanged hashes after gateway restart.
- Mark-reviewed and other metadata transitions leave the pinned bundle unchanged.
- Resolve every client, CLI and publication reader from a bundle with node reads
  forbidden; verify report open under two seconds on a backfilled retained run.
- Fail interrupted/concurrent captures safely; verify shared Run-store/sandbox
  root pairing, stale/foreign references, imports, partial backfill, idempotent
  retries and GC during publish/reference commit.
- Fill the media budget: a new report remains readable; pinned media survives,
  eligible media becomes pruned and metadata/history hashes stay unchanged.
- Stale reports open with a warning while proof and publication still refuse.
