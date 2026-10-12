# Review curation and saved results

Normative contract for [ADR-068](../adr/068-shared-review-curation-and-results.md).

## Publication view

An `engine_review_posting` decision with a review payload exposes all inline
findings, their selection and the saved recommendation. Initial selection is
all findings. An explicit empty `includedIndices` means no inline comments.
Changing selection changes the publication request, not the saved report.
The view explains that the full report remains unchanged. Existing recommendation
and attachment choices are preserved; unavailable evidence controls are omitted.

Inspection labels the reviewed SHA and finding location. Source reads use
`git.show` with that SHA and path, scoped to the review run or existing slot.
The existing native diff/code viewer shows numbered context and the target line.
A missing SHA, unavailable object/file or out-of-range line has an explicit
unavailable state with retry where applicable. Never label mutable workspace
content as reviewed source. Another finding/review/connection invalidates pending
source reads. Loading and errors keep the finding and its selection visible.

The portable fingerprint identifies the reviewed base/head, diff hash and
untracked path/blob/mode identities, original
report, original recommendation and ordered findings. It excludes transient
fetch URLs and capture timestamps. New client Post requests use the shared
builder and carry `selectionData.reviewFingerprint`, `includedIndices` and
existing recommendation/evidence fields. The fingerprint is captured with the curation payload. Gateway validates it
before any restore and again at the final consumption point after awaited
checks; mismatch returns a review-changed error and leaves the gate unresolved. Missing fingerprint preserves legacy
request behavior. A new payload resets native selection and source inspection;
confirmation cannot send an earlier payload's curation for a replacement.
Both clients invalidate an armed confirmation when that fingerprint changes.
Desktop preserves its current identity-based refresh inclusions and evidence
overrides; native resets selection. Curated native Post must use the run resolver
with explicit selection; no fallback to selection-free global decision resolution.

After asynchronous refresh reads, re-read the pending decision. Refuse a
resolved/replaced id or a changed starting fingerprint, before updating its
payload or retained result. This applies to both workspace and slot refresh.

Every publication path captures finding list, report, recommendation and reviewed
source from the accepted decision synchronously when the gate await returns.
These fingerprinted fields are immutable; later quality/upload metadata is not
part of that claim. Workspace and slot publication must not
use an earlier closure copy. The slot formal poster consumes a gateway-owned
`--review-input-file` instead of a subsequently edited worker report. Its formal finding section uses only the selected findings, while the original
review report text remains unchanged. Preserve existing selected off-diff report
appendices and evidence overrides.

## Saved view

The second delivery renders `reviewResultForRun(run)` after the publication gate
closes, including saved-but-unpublished and automatically finished reviews.
Display raw saved verdict, full reviewed SHA and the complete report through the
existing document viewer. Use the retained result first, then the latest
historical review payload. Load full run detail before declaring trimmed or
missing data absent. Explain missing historical fields. Render publication
status and requested publication recommendation/selected count independently; reading does not publish, resolve or modify anything. A receipt event is
confirmed only when present; requested indices do not prove a provider accepted
each finding. Do not manufacture slot publication receipts or counts.
Use the same native review renderer in read-only mode, without selection or
posting controls. Reopen/reconnect reloads current authorized run detail and
rejects stale responses from another connection or run.

## Public surface

`@farmslot/protocol` exports `savedReviewView` beside `reviewResultForRun` for the
native saved-result reader. Both read existing Run fields and add no storage or RPC.
It owns pure finding/curation models and optional fingerprint
validation for the two clients and gateway. Existing request/response methods,
review result persistence and review-dispatch controls remain the consumers.
No new public command, flag, harness extension or result-store version. The
internal post-review snapshot flag is owned by the gateway slot publisher.

## Acceptance

Native proof consumes the Expo adapter's existing selected-device recording
target and Android recorder. Explicit recording target overrides retain precedence.

1. Phone inspection shows the finding beside source from its reviewed SHA even
   when the current checkout differs. Missing source is explicit.
2. Select/deselect and select-none produce exact indices; confirmation sends
   those indices through the production resolver. The outgoing inline payload
   contains only selected findings and preserves the reviewed head on both
   workspace and slot publication. Refresh/reorder proof checks actual outgoing
   finding body, path and line, not merely saved indices. Also assert formal report
   text/recommendation and formal finding selection when worker artifacts change
   after acceptance. A refresh in flight during resolve must preserve the
   accepted persisted payload/selection and outgoing result.
3. Payload replacement and reconnect cannot apply stale curation or source;
   mismatched fingerprints leave the gate pending.
4. Original report/result remain unchanged by curation or posting.
5. Saved published, unpublished and auto-finished reviews remain readable after
   gate closure, with exact verdict/SHA/report and no write action from reading.
6. Unit checks cover shared projections, empty selection, freshness and legacy
   data. Each PR has a connected recipe on the operator's phone platform proving RPC/store effects and HUD
   stills with intents shorter than 80 characters. Browser proof validates any
   changed desktop rendering. Proof uses no external review posting.
