# ADR-068: Shared review curation and saved results

Status: Proposed

## Context

The phone's review-posting decision shows the verdict and report, but omits
finding selection and reviewed-line inspection. After that decision closes,
Command Center reads the retained `Run.reviewResult`; Companion shows only
publication status. ADR-063 already supplies shared review choices and lineage.
This decision covers the requested phone publication and saved-result parity.

## Decision

Extend the existing native review-publication component and controller for
curation and, in the next PR, a read-only saved-result context. Keep one native
renderer per job. Reuse the existing diff/code viewer and document viewer.
Move the existing desktop comment identity/grouping helpers into protocol and
share the curation projection, recommendation normalization and serialization.
The existing dispatch picker remains the owner of review-request choices.

Show each finding's path, line, severity and body. Include all initially;
explicitly submit selected indices, including an empty array. Recommendation
and evidence inclusion keep existing publication semantics. Inclusion controls
inline comments; the original report stays unchanged. Inspect source with
existing `git.show` at the recorded reviewed SHA, using the run's review
workspace or slot. Missing revision, file or line is unavailable, never replaced
with current checkout content. Preserve existing GitHub freshness checks.

Bind curation to the exact reviewed head/base, diff identity and untracked blobs, report,
recommendation and finding list. Use the existing portable SHA-256 helper.
`run.resolveDecision` accepts an optional `selectionData.reviewFingerprint`;
the shared request builder supplies it for review Post actions. Refuse mismatches
before any restore and again after the final await, before resolving the gate. Existing callers without it retain their current
behavior. A changed payload resets native curation; late reads from another
finding, review or gateway cannot replace the visible source.
The fingerprint comes from the payload that produced the curation, not a later
live payload. Payload replacement invalidates an armed confirmation in both
clients. Desktop retains its existing identity-based refresh selections and
evidence overrides; native resets its selection. Curated Post requires the run
resolver, never the selection-free global decision fallback.

Both workspace and slot publishers capture the accepted decision payload
synchronously when the gate await returns, before further awaits. Refresh
rechecks the pending decision id and original fingerprint after its reads and
refuses writes after resolution or replacement. Fingerprinted source, report,
recommendation and findings stay immutable; later quality/upload metadata does
not redefine them. They may not filter a pre-gate captured finding list or reread a mutable
report in place of that payload. Slot formal posting accepts an internal
`post-review.sh --review-input-file` snapshot supplied by the gateway. The snapshot supplies selected findings to both inline and formal finding
sections, while preserving the original report text. Selected off-diff findings
retain the existing provider appendix behavior.

The saved reader consumes existing `reviewResultForRun`, preferring retained
results and using historical review payloads when needed. It shows the saved
raw saved verdict, reviewed SHA and report after Post, Dismiss or automatic finish.
Publication state and requested recommendation/selected count are separate.
A receipt-confirmed event is labelled confirmed; absent receipt/count data is
not invented from requested choices. Absent historical data is explicit. It offers
no posting or curation through the read-only view.

## Public surface

- RPC: existing `git.show`, `git.diff`, `run.get` and `run.resolveDecision`;
  additive optional review fingerprint in existing selection data. No new RPC.
- SDK: additive pure review presentation/curation exports in
  `@farmslot/protocol`, consumed by both clients and gateway validation.
- No public CLI flags, harness hooks, result-store schema or review-policy change.
  The internal snapshot flag above is consumed only by the gateway slot publisher.
  Harnesses inherit the existing saved result and optional selection contract.

## Non-goals

Review generation, WARM/COLD dispatch policy, reruns, report rewriting,
publication account policy, gate approvals, evidence-engine changes and HTML
report rendering. No duplicated viewer, picker or report component.

## Delivery

First PR adds finding curation and reviewed-line inspection. After its closeout,
a second PR enables the saved-result context on the same native component.
Each has unit checks and a connected recipe on the operator's phone platform with HUD stills. Private gateway
proof must exercise the production resolver and verify persisted selection plus
outgoing payload on both workspace and slot paths using an isolated provider
sink with stubbed reads and writes, without GitHub mutations. Assert report/recommendation, finding reorder, and
refresh-in-flight during resolution without altering accepted data.
