# Farmslot review rules

This is the canonical Farmslot rule set and reviewer execution template, maintained for F382. Static reviews retain it through `static_review.instruction_files`; lane reviews read the same file from the reviewed checkout. Change this source, never a frozen task copy.

## Execute the review

1. Freeze the publication base, head and reviewed range. Inventory every changed path against the approved request, using the shared `review-diff-scope.cjs` packet when available. Warm reviews retain the whole-contribution scope inventory and inspect their saved correctness delta.
2. Read each rule below and decide applicability from the diff and affected callers. Open applicable source, producer contracts and tests. A family heading or a claim that a file was read is not an outcome.
3. Put a criteria ledger in the requested review artifact, normally `artifacts/review.md`. Include one row per rule, including exclusions:

   `Rule ID | Applies and why | Outcome | Frozen source/test evidence or gap`

   Outcomes are `PASS`, `FINDING`, `NOT_APPLICABLE` and `NOT_CHECKED`. `PASS` needs cited evidence; `NOT_APPLICABLE` needs a concrete scope reason. Missing source or runtime proof is `NOT_CHECKED`, never an assumed pass. Report an incomplete review explicitly.
4. A `FINDING` needs a concrete failure, its applicable rule, and a changed line or affected changed caller. Every confirmed violation of an applicable rule blocks and requires `REQUEST_CHANGES`. Other findings follow the shared approval policy. A coverage gap alone is not an invented behavior defect. Put pre-existing, unrelated issues outside the diff findings.
5. State the frozen head, completeness and evidence limits before the verdict. Use the existing report/signal contract; this file adds no new verdict or protocol field.

Respect the selected validation depth. A static review reads retained source, tests and supplied evidence; it does not acquire a device, start services, dispatch a run or publish. Record missing runtime evidence without claiming it was obtained. For an authorized live review, use the existing recipe-quality guidance and assert the observable result through the real client or gateway. Pixels prove rendering; retained bytes and state readbacks prove data changes. Never inject UI/store values as proof.

## Rules

### FSR-01. Fix the demonstrated failure at its shared owner

- Applies to fixes, migrations and new abstractions.
- Inspect the approved trigger and the changed producer, sibling callers and replacement path. Prefer removing the failing work. Carry every required capability to its single owner; remove the replaced path instead of adding a shim, alias or parallel implementation.
- Contradicted by a speculative fix with no approved scope or reproduction, a timeout increase that leaves the demonstrated redundant work, or a second implementation serving the same contract. Explicitly approved planned work is a valid trigger.
- Failure: F310/F313 led to removing release copies in [#1747](https://github.com/deeeed/farmslot/pull/1747); F318 needed one worker/preflight environment in [#1758](https://github.com/deeeed/farmslot/pull/1758). F382 carries the standing no-shims and real-bugs-only requirements.

### FSR-02. Use current authoritative facts, not inferred state

- Applies to state classification, identity discovery, publication verification and configuration selection.
- Inspect where each fact comes from and when it remains authoritative. Use explicit dispatch/API records, native receipts and the actual remote or producer. Never derive tickets, ownership, acceptance or completion from free prose, TUI appearance or a regex over incidental text. Parsing a documented wire format or identifying a process from argv is distinct from inferring its turn state.
- Contradicted by a local tracking ref treated as proof of the actual remote branch, an unrecognized producer status treated as absence, or business state guessed from display text. Missing facts remain unknown or explicitly refused.
- Failure: F301 lost a valid session status, fixed by [#1720](https://github.com/deeeed/farmslot/pull/1720); F326 rejected an already pushed branch from a stale ref, fixed by [#1767](https://github.com/deeeed/farmslot/pull/1767). F382 also carries the standing no-prose-inference requirement.

### FSR-03. Prove ownership and quiescence before destructive cleanup

- Applies to stop, release, cancel, archive, reset and replacement.
- Inspect all recorded and unrecorded workers, resource owners, handoffs and process identities before acting. Recheck the claim/epoch after asynchronous inspection. Only the owner's confirmed processes may stop; unreadable identity and a protected worker preserve the hold.
- Contradicted by killing before an unrecorded-worker check, treating a missing node as proof of exit, or resetting a checkout after its owner changed. A safe hold is not evidence that cleanup should bypass its guard.
- Failure: F315's unrecorded idle worker required guarded ownership in [#1755](https://github.com/deeeed/farmslot/pull/1755). F375 and the preservation finding in [#1824](https://github.com/deeeed/farmslot/pull/1824) require daemon cleanup after worker checks.

### FSR-04. Persist handoffs and preserve history across interruption

- Applies to asynchronous delivery, replay, restart, recovery and replacement of durable records.
- Inspect the durable marker before the effect, exact acceptance binding, generation checks and recovery branches. Reattach to an acknowledged turn; uncertain delivery preserves the worker. Append or retain decision history before replacing an active list.
- Contradicted by re-sending an acknowledged prompt after restart, rebuilding ownership from a display flag, a late result acting on a newer generation, or dropping resolved records without durable preservation.
- Failure: F331/F332 were fixed by [#1782](https://github.com/deeeed/farmslot/pull/1782) and [#1788](https://github.com/deeeed/farmslot/pull/1788); F347/F351 required stable gate IDs and durable history in [#1797](https://github.com/deeeed/farmslot/pull/1797).

### FSR-05. Refresh must preserve requested gate authority

- Applies to package refresh, readiness, action projection, approval and final publication.
- Trace the operator's requested policy and the exact reviewed head/inputs through every reader and mutation-time check. Refresh may invalidate stale proof; it may not silently weaken the requested policy. Available actions and final enforcement must agree.
- Contradicted by replacing a requested review requirement with a weaker project default, offering publication despite a known conflict, or accepting an approval against another package or head.
- Failure: F302's unmergeable publication action was fixed by [#1728](https://github.com/deeeed/farmslot/pull/1728); F346's refresh lowered a required review, fixed by [#1792](https://github.com/deeeed/farmslot/pull/1792).

### FSR-06. Bound work at the correct owner and keep idle reads cheap

- Applies to polling, file acquisition, retention, locks, resource hooks and interactive reads.
- Enumerate the work added per poll, slot and run, including subprocesses and bytes. Reuse retained results, batch host work and keep heavy acquisition off unviewed/interactive paths. Locks cover the owning run/resource, and timed-out effects cannot retain a farm-wide queue indefinitely.
- Contradicted by recopying evidence during release, full per-slot inspection without a viewer, or unrelated runs waiting behind one unbounded hook. A larger deadline does not remove unnecessary work.
- Failure: F313 removed duplicate acquisition in [#1747](https://github.com/deeeed/farmslot/pull/1747); F330 split the farm-wide queue in [#1778](https://github.com/deeeed/farmslot/pull/1778); F372 removed background workspace probes in [#1823](https://github.com/deeeed/farmslot/pull/1823).

### FSR-07. Bind evidence and caches to their actual retained identity

- Applies to output acquisition, digests, caches, reports, review findings and publication evidence.
- Trace producer through retention, selected attempt/head, consumer and displayed claim. Serialize competing writes at their owner. Keep task paths and recipe paths distinct. Exclude only paths explicitly omitted by the retained bundle, and preserve all other missing/changed refusals.
- Contradicted by a stale-head cache used for a current package, overlapping captures that overwrite each other, an alias opening another artifact, or a pass derived from evidence belonging to another attempt. Missing or untimed evidence stays honestly labeled.
- Failure: F304/F305 required exact exclusions and per-run acquisition in [#1722](https://github.com/deeeed/farmslot/pull/1722) and [#1731](https://github.com/deeeed/farmslot/pull/1731); F341/F343 corrected artifact and head identity in [#1794](https://github.com/deeeed/farmslot/pull/1794) and [#1795](https://github.com/deeeed/farmslot/pull/1795).

### FSR-08. Validate real contracts and make tests contradict the bug

- Applies to boundary decoding, type changes, fixtures and regression tests.
- Read the producer and every required field. Narrow unknown input or construct a typed fixture; never double-assert through `unknown`, `any` or an equivalent intermediate type. An invalid-input test names its expected type error. Verify the test reaches the changed behavior and fails when that behavior is removed, rather than asserting an unused field or rebuilding the implementation's answer.
- Contradicted by a forced value presented as valid domain data, a fixture that passes only because its runner skips typechecking, or a purported behavior assertion that has no consumer-visible effect.
- Failure: review of [#1698](https://github.com/deeeed/farmslot/pull/1698) found incomplete claim fixtures that passed execution but failed the contract typecheck, and a tested field unused by judgment controls. F382 retains the standing ban on double assertions.

### FSR-09. Test time through a controllable clock

- Applies to tests of sleeps, polling, retry, timeout and cleanup timing.
- Inspect the clock and scheduler the code actually reads. Drive elapsed time with fake timers or injected time, restore them on every exit, and wait for observable completion rather than a guessed delay. Live proof of external processes uses bounded condition checks in its authorized scope and does not substitute for a timer regression test.
- Contradicted by waiting out a production delay in a unit/CI test, a fixed sleep presented as proof that an effect finished, or fake timers that leave an asynchronous completion path untested.
- Failure: review of [#1708](https://github.com/deeeed/farmslot/pull/1708) caught a fixed-sleep proof; F382 imports the standing real-timer prohibition after repeated slow and flaky tests.

### FSR-10. Share UI state and keep asynchronous layout stable

- Applies to Command Center and Companion views, shared models, loading, warnings and errors.
- Trace the common view model and every affected client. Keep useful prior data during background reads. Reserve the final layout space or use an overlay for transient content; inspect poll/load/error transitions and the actual rendered or accessible state when evidence is supplied.
- Contradicted by separate implementations of one shared decision, controls reading a different flag than the test, or a banner/skeleton changing surrounding layout on each refresh. Static source inspection does not establish a measured visual result.
- Failure: F342's misleading panels/rounds were fixed in [#1793](https://github.com/deeeed/farmslot/pull/1793) and [#1806](https://github.com/deeeed/farmslot/pull/1806); [#1819](https://github.com/deeeed/farmslot/pull/1819) corrected terminal layout and irrelevant progress notices.

## Maintaining the rules

Use `.agents/skills/fs-retro-bulk/SKILL.md` Pass 2. After a review miss or incident, verify the claim against the actual run, diff, tests, review or gate outcome. Add or sharpen a rule only for a confirmed real failure likely to recur and only when the new wording changes a future diff review. Link the F-entry or PR, retain the four fields above and update an existing rule before adding another. A code fix that removes the entire class replaces the instruction; keep a broader check only when its remaining scope is demonstrated.

For each curation, record the destination rule ID, evidence and net instruction lines added. Remove rules that are obsolete, duplicate another owner or repeatedly never apply to their declared scope; preserve useful failure provenance in the linked PR rather than adding run histories here. "No rule change" is a valid result. Do not auto-append rules or create a service, scheduled generator or another rule catalog.

When curated feedback has landed, use fs-retro-bulk's existing canonical-rule consumption ledger with the merged commit and rule destination. Only real provider feedback candidates enter that ledger; never invent a comment identity for an incident. Resolve only the audited decisions through its existing guarded closeout. Do not resolve live retros as part of a documentation or proof run.
