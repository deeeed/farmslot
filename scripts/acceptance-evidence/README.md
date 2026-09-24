# Textual acceptance-evidence pilot v2

Scope: the approved [structured-assessment evaluation plan](../../docs/plans/structured-assessment-evaluation.md), textual AC/evidence consumer. These invented cases do not contain company data. Their reference labels were authored before any provider calls. Do not send `labels.v1.json`, its rationales, split designation or IDs to a provider. A separate reader must check the reference labels against the input text before live evaluation; authorship alone is not independent adjudication.

The hypothesis is that optional, provider-neutral text assessment helps an operator or agent find unsupported or contradicted AC claims with fewer total tokens or less time **at equal correctness**, without changing the authoritative acceptance ledger. An answer is `supported` only when the identified textual evidence proves the full claim. It is `contradicted` when the evidence directly conflicts with a material part. Otherwise it is `insufficient`, including absent records, unverifiable absence claims and untrusted instructions in output. Text cannot prove screenshot appearance. The two `excluded` cases test the no-call boundary for visual and mixed proof.

The frozen v2 case and label file SHA-256 hashes are:

```
2d922bb707564cda110b69db37752b84216e99f73e120518542a7a661b4e7d18  cases.v2.json
f32c5d367ed71ceae38b8aec883f6cb94780206fe8021d38916c6b133d6223c9  labels.v2.json
```

Run `node scripts/acceptance-evidence/check.mjs` to verify both hashes, label coverage and the two no-call cases.

There are three development examples and nine held-out examples, balanced across the three judgments, plus two excluded proof modes. Do not tune the held-out cases after a model run. v1 is retained for audit, but its development HTTP case was ambiguous and its AC IDs leaked the held-out labels. v2 corrects that case and uses AC-1 for every case. The importer must send only the criterion text and named evidence, never the case ID, split or labels. A further change to inputs, labels, rubric or split requires v3 and a new hash.

The baseline is an unassisted validator reading the same criterion and identified text evidence through the existing acceptance workflow, without seeing labels or provider advice. For a paired task study, assign matched cases in counterbalanced order, record the validator's verdict, the evidence IDs used, elapsed time and total agent tokens/cost. Repeat with opt-in advice shown and have an independent reader judge correctness while blind to the lane. Count every assessment attempt, including failed calls, latency, input/output/cache tokens, estimated/reported/unknown cost, and time spent reading advice. Report accuracy and a confusion matrix on the nine held-out cases, false confident judgments on insufficient cases, skipped visual/mixed calls, exclusions and each pair's whole-workflow measures. Missing usage, unmatched pairs or unequal correctness means efficiency is inconclusive. No response in these synthetic cases establishes accuracy for production evidence.

Before any live call, verify the model's current price and request/output token bounds, freeze a spend cap and the two hashes, record explicit admission of **only** these synthetic packets, and use the gateway's existing per-request reservation. No retry, fallback, hidden batch, company log, screenshot or automatic background assessment. A credential alone must never trigger an assessment. A first test can use a fake provider through the real gateway RPC to prove the disabled, refused and recorded paths without spend.

Pilot decision: hold if any visual/mixed case reaches a provider, any unadmitted text is sent, any assessment writes the authoritative ledger, a definite judgment is wrong on an insufficient held-out case, held-out accuracy is below 8/9, or paired whole-workflow quality falls. A classification pass alone is not an efficiency pass. Without complete paired time and total token/cost data, report benefit as unknown.
