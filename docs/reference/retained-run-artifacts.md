# Retained run artifacts

Status: Proposed, [ADR-039 Amendment 1](../adr/039-run-portable-bundles.md#amendment-1-2026-10-15-gateway-retained-run-artifacts).
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

The digest is SHA-256 of the exact stored `manifest.json` bytes. Existing manifest
entries bind each relative payload path, SHA-256 and byte size. `runs/` contains a
sanitized capture-time record; the existing Run store remains lifecycle authority.
No object database, alternate manifest or per-client package parser is introduced.

Stage under the same gateway home, enforce path containment and byte budgets,
stream-copy/hash files, then publish by atomic rename. Fence the Run reference
update against the captured run/task/generation. A concurrent successor or failed
copy MUST NOT replace a committed reference. A retry of the same captured
inventory MUST reuse the committed bundle rather than duplicate its bytes.
Staging and committed entries MUST NOT be writable through artifact readers.

Missing files or differences from a historical inventory are recorded through
existing manifest `missingData` and the capture result. A partial capture is never
presented as a complete evidence closure. An available retained report remains
readable with that limitation; package integrity failures remain non-waivable.

## References and readers

Protocol owns `RunArtifactBundleRef`, containing the bundle digest and task key.
Run output and prepared publication packages carry their capture's reference;
output decisions, review receipts and attestations bind that digest through their
existing snapshot identity. An optional current reference may advance only after
explicit new capture. Previously reviewed references MUST remain unchanged.
Mark-reviewed, archival and other metadata-only transitions MUST NOT recapture,
repoint, or rewrite report/evidence bytes.

Every artifact consumer MUST resolve from the referenced gateway bundle:

- `run.recipeRunsForRun`, report loading, artifact listing and HTTP file/range reads;
- Command Center, Companion and CLI inspection;
- prerequisite/publication selection, descriptions and subsequent export;
- recorded-evidence acquisition feeding the existing SDK reader/model/validator.

A request carrying a gate/review identity MUST use that identity's pinned bundle,
not the Run's latest reference. Historical links retain their digest. Cross-run
or unknown references MUST be refused using the existing authorization boundary.
A run without retained bytes reports retention missing and the supported recovery
action. It MUST NOT fall back to a live slot, including when the node is online.
Operational worker monitoring is separate from retained artifact reading.

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
Both limits include in-progress reserved copy bytes. They do not change recorder,
transcode, source-artifact or existing evidence-validation limits.

Retain snapshots while referenced by any retained Run, output decision, review,
attestation, publication package or comparison dependency. There is no automatic
age expiry for referenced history. Deleting a Run does not remove a snapshot
still referenced elsewhere. GC MUST recheck references before deletion and MUST
ignore active capture staging. It may remove unreferenced committed bundles and
abandoned staging older than 24 hours, on startup and before capacity refusal.

If GC cannot make room, fail capture with an explicit capacity error. Preserve
previous committed bundles and references; do not truncate video, drop selected
files, or evict reviewed snapshots to admit new work. Operators can change the
server-owned limits or delete history through its existing supported lifecycle.

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
references and request/result types. Existing SDK evidence exports remain the
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
Package releases use normal additive versioning; worker-loaded consumers, if
changed, must be released and verified installed before rollout claims.

## Required verification

- Change/reuse or disconnect the source slot after capture and review: the same
  report and evidence remain readable with unchanged hashes after gateway restart.
- Mark-reviewed and other metadata transitions leave the pinned bundle unchanged.
- Resolve every client, CLI and publication reader from a bundle with node reads
  forbidden; verify report open under two seconds on a backfilled retained run.
- Fail interrupted/concurrent captures safely; verify stale/foreign references,
  partial backfill, quota refusal, pinned-history GC and idempotent retries.
- Stale reports open with a warning while proof and publication still refuse.
