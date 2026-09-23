# Structured assessment acceptance ledger

Tracks the [approved evaluation plan](../plans/structured-assessment-evaluation.md).
An implemented call path and a measured benefit are separate claims. A passing
transport fixture or synthetic classification gate cannot establish workflow
savings. Keep this ledger current when each consumer changes.

| Consumer                               | Implemented path                                                                                                 | Quality evidence                                                                                                                       | Matched workflow evidence                                                                                                                                                           | Next gate                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded-failure triage                | Opt-in pilot shipped in #714; v2 classifier result                                                               | [v2 held-out report](../../scripts/failure-triage/results/v2-held-out/report.md): 17/21 correct on synthetic cases                     | Eight paired navigation cases: two assisted-better on abstentions, four both rejected, two equal accepted; the assisted arm used 48% more tokens and took 10.6% longer on those two | Hold any efficiency claim; investigate the abstention-prompt confound before designing a new frozen comparison                                                 |
| Textual acceptance criteria / evidence | Opt-in advisory text-only assessment shipped in #730; visual/mixed proof refused; authoritative ledger unchanged | Independent label-only reader agreed on all 12 frozen v2 text cases and refused both visual/mixed exclusions; no paid model comparison | None                                                                                                                                                                                | Freeze known-case claims and independent references, then compare supported/contradicted/insufficient verdicts and operator time against unassisted validation |
| Static-review checklist                | No evaluated consumer                                                                                            | None                                                                                                                                   | None                                                                                                                                                                                | Freeze checklist applicability and known defects or independent strong-review reference before candidate calls                                                 |
| Copilot context support                | No evaluated consumer                                                                                            | None                                                                                                                                   | None                                                                                                                                                                                | Compare matched diagnostic tasks, including evidence reads and all context/advice overhead                                                                     |
| Review-routing advice                  | No evaluated consumer                                                                                            | None                                                                                                                                   | None                                                                                                                                                                                | Compare routing decisions against the existing route and matched review tasks                                                                                  |

#723 added opt-in advice for pending run decisions; #728 added decision history visibility. This is distinct from review routing and has no paired outcome study yet. The profile-preview follow-up
saved after #726 is a separate UI/proof change. Neither is evidence that the
five consumers above have a measured efficiency benefit.

An unmerged multi-turn study path exists in the triage worktree. Its reviewed,
eight-case synthetic corpus permits two named evidence reads in three turns.
TypeSafe supplied five first-read hints and abstained three times. A complete,
independently blind-judged paired run used the same `gpt-6-luna` worker through
`codex-lb` in both arms. All 48 worker turns completed without failed calls.
The scorer reports `inconclusive`: two assisted-better cases both had TypeSafe
abstentions, four cases were rejected in both arms, and only two pairs had equal
accepted quality. On those two, advice-inclusive assisted totals cost 48% more
tokens and 10.6% more wall time. The dollar comparison uses published
API-equivalent rates, not a verified load-balancer bill. Keep full judgments
and journals in the private operator artifacts described in the evaluation guide.
This sample is evidence against an efficiency claim, not a population estimate.

The recorded-failure panel stores assessment cost and optional accuracy feedback. PR #731 links a saved assessment to an explicitly chosen action and refreshes its history. Its synthetic gateway/browser proofs make no external provider calls. That association cannot establish whether advice caused the choice or saved operator time. Local assessment storage may have no retained records; an empty cohort has no accuracy denominator.

For each new row result, retain the case and rubric versions, admitted source,
model/provider, typed answer, abstention or failed call, known and unknown
spend, advice use, baseline and assisted quality, matched token/cost/time totals,
and a pilot/hold/inconclusive decision. Record the exact PR and proof artifacts
before calling a row complete.

The AC label-only audit compared an independent reader of `cases.v2.json`
against `labels.v2.json` after the reader finished. It agreed on all three
development and nine held-out labels, and refused both excluded proof modes.
Frozen case hash: `2d922bb707564cda110b69db37752b84216e99f73e120518542a7a661b4e7d18`;
label hash: `f32c5d367ed71ceae38b8aec883f6cb94780206fe8021d38916c6b133d6223c9`.
This checks labels, not provider accuracy or operator efficiency.
