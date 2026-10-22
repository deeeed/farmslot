# Review curation and saved results

**Status:** Accepted under [ADR-062 review curation decision](../adr/062-recorded-run-evidence.md#shared-review-curation-and-saved-results).
**Implementation:** Finding curation and reviewed-line inspection merged in [#963](https://github.com/deeeed/farmslot/pull/963); the saved-result reader merged in [#985](https://github.com/deeeed/farmslot/pull/985).

This delivered contract is separate from the Proposed completed-evidence/storage
work in [#967](https://github.com/deeeed/farmslot/pull/967). It does not accept or
implement that proposal.

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

Reviewed Git reads MUST drain their output before returning. A source file MUST
not be truncated to the transport pipe buffer, and an unavailable finding line
MUST NOT be clamped to the final source line. The viewer labels the reviewed SHA.

Inspection links retain `commentFile`, `commentLine`, `comment` and `commentHead`.
`comment` is a content-derived finding identity, independent of list order.
Opening a link restores the file, real line and selected finding after the review
and source load. A changed review revision or missing finding is explicit and
never selects a different finding by index. File-tab navigation clears finding
selection. These parameters inspect saved data and never post or curate findings.

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

The saved-result reader renders `reviewResultForRun(run)` after the publication gate
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
Shared comment identity/grouping, recommendation normalization and serialization
belong to the same protocol projection, used by both clients. The existing
`reviewCommentLocation`, `reviewCommentIndex`, `parseReviewCommentLocation` and
`writeReviewCommentLocation` exports own inspection-link selection for Command
Center and future Companion link restoration. Existing `VIEW_QUERY_PARAMETERS`
admits those inspection parameters without accepting credentials or operations.
The existing
ADR-063 dispatch picker remains the owner of review-request choices. The saved
reader retains results after Post, Dismiss or automatic finish.
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

Private gateway acceptance MUST exercise the production resolver and verify
persisted selection plus outgoing payload on both workspace and slot paths,
using an isolated provider sink with stubbed reads and writes, without GitHub
mutations. Assert the report/recommendation, finding reorder and refresh in flight
during resolution without altering accepted data.

## Boundaries

Review generation, WARM/COLD dispatch policy, reruns, report rewriting,
publication account policy, gate approvals, evidence-engine changes and HTML
report rendering remain outside this contract. Reuse the existing native review
component/controller, diff/code viewer and document viewer, without another
viewer, picker or report component.
