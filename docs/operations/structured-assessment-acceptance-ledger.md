# Structured assessment acceptance ledger

Tracks the [approved evaluation plan](../plans/structured-assessment-evaluation.md).
An implemented call path and a measured benefit are separate claims. A passing
transport fixture or synthetic classification gate cannot establish workflow
savings. Keep this ledger current when each consumer changes.
Assessment history shows individual outcomes, operator feedback, associated chosen actions, and per-consumer/provider/model usage, cost provenance and latency across retained records. Missing usage stays unknown; these descriptive totals do not establish accuracy or workflow savings.

| Consumer                               | Implemented path                                                                                                 | Quality evidence                                                                                                                                                          | Matched workflow evidence                                                                                                                                                           | Next gate                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded-failure triage                | Opt-in pilot shipped in #714; v2 classifier result                                                               | [v2 held-out report](../../scripts/failure-triage/results/v2-held-out/report.md): 17/21 correct on synthetic cases                                                        | Eight paired navigation cases: two assisted-better on abstentions, four both rejected, two equal accepted; the assisted arm used 48% more tokens and took 10.6% longer on those two | Hold any efficiency claim; #736 excludes the failed draft, reports offline read diagnostics and seals optional worker limits before advice        |
| Textual acceptance criteria / evidence | Opt-in advisory text-only assessment shipped in #730; visual/mixed proof refused; authoritative ledger unchanged | Independent labels agreed on v2 and gateway-compatible v3 text cases; the v2 Jev adapter probe was 8/9 with a wrong definite `supported` verdict on insufficient evidence | None                                                                                                                                                                                | Hold Jev for this consumer; v3 needs actual gateway receipts, an independent provider-quality gate and paired validation before any benefit claim |
| Static-review checklist                | No evaluated consumer                                                                                            | None                                                                                                                                                                      | None                                                                                                                                                                                | Freeze checklist applicability and known defects or independent strong-review reference before candidate calls                                    |
| Copilot context support                | No evaluated consumer                                                                                            | None                                                                                                                                                                      | None                                                                                                                                                                                | Compare matched diagnostic tasks, including evidence reads and all context/advice overhead                                                        |
| Review-routing advice                  | No evaluated consumer                                                                                            | None                                                                                                                                                                      | None                                                                                                                                                                                | Compare routing decisions against the existing route and matched review tasks                                                                     |

#723 added opt-in advice for pending run decisions; #728 added decision history visibility. This is distinct from review routing and has no paired outcome study yet. The profile-preview follow-up
saved after #726 is a separate UI/proof change. Neither is evidence that the
five consumers above have a measured efficiency benefit.

PR #732 merged the multi-turn study path. Its reviewed,
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
All five named hints matched the baseline worker's first read; none changed the first evidence choice. Seven of eight cases require two reads, the study maximum, so the accepted answers could not save a read under this design. Future runs represent a provider abstention as null advice in the worker prompt while retaining the paid receipt. The frozen run above used an abstention message and remains unchanged. A new independently reviewed corpus must allow a useful hint to change the work before any further candidate calls.
PR #736 adds offline first-read and read/turn diagnostics. Its revised corpus
failed a source-only label review and is excluded from the shipped case files.
A metadata-only first-read check chose a required source in 6/8 draft cases. No
new advice calls or paired workflow results were produced; the efficiency
claim remains on hold.

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

The [AC v2 TypeSafe adapter probe](../../scripts/acceptance-evidence/results/v2-typesafe-adapter.json)
ran September 24, 2026 against the pinned synthetic text corpus, through the
production TypeSafe adapter using Choice wording and criterion/evidence fields copied from the gateway
consumer. The probe did not record a packet hash or gateway history. The adapter received 12 completed responses from
`jev-1.13.0` with 5,691 input and 561 output tokens and an estimated USD 0.000239 at the
[verified model price](https://docs.typesafe.ai/models); the reserved maximum
was USD 0.005. The adapter disabled SDK retries, and the saved probe has
12 call records; this artifact cannot independently prove the provider saw no
other calls. `node scripts/acceptance-evidence/check.mjs` recomputes the
recorded counts and held-out verdicts against the pinned labels. The provider got
8/9 held-out labels right but chose `supported` for `held-insufficient-negative`:
one worker's zero outbound requests cannot establish that **no worker** sent
customer data. This fails the predeclared no-wrong-definite-verdict rule, so the Jev
AC pilot is **hold** regardless of its other metrics. No gateway history or
paired baseline/assisted worker sessions were collected in this probe. The
receipts are adapter-level observations, not an efficiency result or a proof
that an opt-in gateway run retained every record. Do not enable routine AC
calls or change the frozen label to chase a pass.

PR [#739](https://github.com/deeeed/farmslot/pull/739) adds a separately
frozen, gateway-compatible AC v3 synthetic corpus. On September 24, 2026, a fresh isolated reader assigned
labels from the final 14-case revision without a reference file; [the blind audit](../../scripts/acceptance-evidence/results/v3-blind-label-audit.json)
retains its prompt and [raw response](../../scripts/acceptance-evidence/results/v3-blind-label-raw.json) and records agreement on all three development and nine held-out cases;
visual and mixed cases were marked no-call. A previous draft reader rechecked Q7 after its identity was made explicit;
the final blind read independently labeled it `contradicted`. The final held-out cases include partial shard coverage, conflicting scheduler files, an aggregate threshold and a policy-probe instruction injection. Final case hash:
`41261ac446de4887d7665b008eef4828dcddb52bbb3a0d21d4a4f66952488085`;
label hash: `4ab04f3a0f4157000f11f425c15092d4603ba9e5f6b7e4255a396efc5a749986`.
The [acceptance-evidence recipe](../../scripts/runner-validation/acceptance-evidence.recipe.json)
runs [the parity proof](../../scripts/acceptance-evidence/gateway-parity.test.mts):
14 temporary run snapshots, 12 persisted assessment receipts from a fake
in-process provider, two visual/mixed no-call checks, and offline packet and
admission binding. The fake provider has the reference answers, so its 9/9
held-out result is a transport check, not evidence of provider accuracy. Equal
validator arms remain inconclusive; no live model call or measured workflow
improvement is claimed. The frozen v2 adapter-only pilot remains **hold**.

The v3 cases are small synthetic checks; several labels depend on one field or
missing outcome. A high score on them cannot establish production accuracy or
repair the wrong definite v2 verdict. The gateway-method test checks retained
record consistency, not export authenticity, provider quality or efficiency.
