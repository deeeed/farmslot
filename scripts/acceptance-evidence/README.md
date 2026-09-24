# Textual acceptance-evidence pilot

Scope: the approved [structured-assessment evaluation plan](../../docs/plans/structured-assessment-evaluation.md), textual AC/evidence consumer. These invented cases do not contain company data. Their reference labels were authored before any provider calls. Do not send any frozen label file, its rationales, split designation or IDs to a provider. A separate reader must check the reference labels against the input text before live evaluation; authorship alone is not independent adjudication.

The hypothesis is that optional, provider-neutral text assessment helps an operator or agent find unsupported or contradicted AC claims with fewer total tokens or less time **at equal correctness**, without changing the authoritative acceptance ledger. An answer is `supported` only when the identified textual evidence proves the full claim. It is `contradicted` when the evidence directly conflicts with a material part. Otherwise it is `insufficient`, including absent records, unverifiable absence claims and untrusted instructions in output. Text cannot prove screenshot appearance. The two `excluded` cases test the no-call boundary for visual and mixed proof.

The frozen v2 case and label file SHA-256 hashes are:

```
2d922bb707564cda110b69db37752b84216e99f73e120518542a7a661b4e7d18  cases.v2.json
f32c5d367ed71ceae38b8aec883f6cb94780206fe8021d38916c6b133d6223c9  labels.v2.json
```

Run `node scripts/acceptance-evidence/check.mjs` to verify both hashes, label coverage and the two no-call cases.

There are three development examples and nine held-out examples, balanced across the three judgments, plus two excluded proof modes. Do not tune the held-out cases after a model run. v1 is retained for audit, but its development HTTP case was ambiguous and its AC IDs leaked the held-out labels. v2 corrects that case and uses AC-1 for every case. The importer must send only the criterion text and named evidence, never the case ID, split or labels. A further change to inputs, labels, rubric or split requires a new corpus version and hash.

The baseline is an unassisted validator reading the same criterion and identified text evidence through the existing acceptance workflow, without seeing labels or provider advice. For a paired task study, assign matched cases in counterbalanced order, record the validator's verdict, the evidence IDs used, elapsed time and total agent tokens/cost. Repeat with opt-in advice shown and have an independent reader judge correctness while blind to the lane. Count every assessment attempt, including failed calls, latency, input/output/cache tokens, estimated/reported/unknown cost, and time spent reading advice. Report accuracy and a confusion matrix on the nine held-out cases, false confident judgments on insufficient cases, skipped visual/mixed calls, exclusions and each pair's whole-workflow measures. Missing usage, unmatched pairs or unequal correctness means efficiency is inconclusive. No response in these synthetic cases establishes accuracy for production evidence.

Before any live call, verify the model's current price and request/output token bounds, freeze a spend cap and the two hashes, record explicit admission of **only** these synthetic packets, and use the gateway's existing per-request reservation. No retry, fallback, hidden batch, company log, screenshot or automatic background assessment. A credential alone must never trigger an assessment. A first test can use a fake provider through the real gateway RPC to prove the disabled, refused and recorded paths without spend.

Pilot decision: hold if any visual/mixed case reaches a provider, any unadmitted text is sent, any assessment writes the authoritative ledger, a definite judgment is wrong on an insufficient held-out case, held-out accuracy is below 8/9, or paired whole-workflow quality falls. A classification pass alone is not an efficiency pass. Without complete paired time and total token/cost data, report benefit as unknown.

## Offline workflow evaluator

`node scripts/acceptance-evidence/evaluate.mjs <study.json>` compares one frozen
study without starting a gateway or calling a provider. It verifies the pinned
SHA-256 hashes, then reads `cases.v2.json` and `labels.v2.json` locally. Its input is an artifact, not a source-admission
mechanism: only use the synthetic corpus here unless a separately approved study
defines another source policy. Company logs are never safe to export by default.

The top-level JSON has `version: 1`, `cases`, and `assessmentRecords` arrays. There must be one
case entry for every frozen ID. Textual cases contain a `baseline` and `assisted`
arm with `judgment`, `elapsedMs`, `workerTokens`, and `workerCostUsd`; each metric
is a non-negative number or `null` when unknown. `assistedRunId` and
`assessmentRecordIds` associate the assisted task with retained gateway records.
Supply the complete unfiltered gateway history export for the studied runs. Every supplied record must be associated exactly once, have synthetic admission, and its run ID, criterion
text, evidence IDs and evidence text must match that frozen case. A run cannot
be reused by another case. The offline evaluator cannot prove that a supplied history export is exhaustive; a missing failed retry can falsely reduce cost. Audit completeness against the gateway before interpreting any `pass`. Visual and mixed entries
must use `baseline: null`, `assisted: null`, and an empty record-ID list.

This is the matching pair of entries inside those two complete arrays, not a
runnable study file:

```json
{
  "caseId": "dev-supported",
  "assistedRunId": "synthetic-run-1",
  "assessmentRecordIds": ["assessment-1"],
  "baseline": {
    "judgment": "supported",
    "elapsedMs": 1200,
    "workerTokens": 300,
    "workerCostUsd": 0.002
  },
  "assisted": {
    "judgment": "supported",
    "elapsedMs": 1100,
    "workerTokens": 240,
    "workerCostUsd": 0.0018
  }
}
```

```json
{
  "version": 1,
  "id": "assessment-1",
  "consumer": "acceptance-evidence",
  "subject": {
    "run": {
      "id": "synthetic-run-1",
      "admission": {
        "classification": "synthetic",
        "sourceRef": "synthetic:acceptance-evidence-v2"
      },
      "criterion": {
        "id": "AC-1",
        "text": "The command prints READY when the service is healthy",
        "evidence": [
          { "id": "stdout", "text": "Exit status: 0\nstdout: READY\nhealth probe status: healthy" }
        ]
      }
    }
  },
  "result": {
    "attempted": true,
    "status": "completed",
    "answers": { "verdict": { "type": "choice", "choice": "supported" } },
    "usage": { "inputTokens": 40, "outputTokens": 12, "costUsd": 0.0001, "durationMs": 80 }
  }
}
```

The complete artifact includes all fourteen case entries. Completed assessment
records retain `result.answers.verdict` as a closed choice; the evaluator reports
its accuracy separately from the validator arms. Assessment records use the
persisted protocol shape. Attempted failed calls count. A missing input or
output token total, cost, or paired workflow measure stays `null`; it is never
counted as zero. Assisted token and cost totals add retained assessment receipts
to the worker measurements; `workerTokens` and `workerCostUsd` must exclude those assessment receipts to avoid double counting. A provider may omit output token usage when output is free; this scorer treats missing output tokens as unknown rather than guessing their count. The whole-task elapsed time is already measured
across advice use, so gateway latency is reported separately and is not added a
second time.

The report exposes provider and validator-arm accuracy against frozen labels,
the held-out provider confusion matrix (including missing verdicts), zero records associated with visual/mixed cases in the supplied export, every supplied attempted call, unknown charges/usage,
and equal-correct held-out paired totals. Development cases do not contribute to the efficiency result. The frozen provider floor applies to one
retained provider verdict for each held-out case: at least 8/9 correct and no
wrong definite verdict on an insufficient case. Missing or repeated provider
verdicts cannot pass. Repeated attempted calls are retained and counted, but
violate the frozen no-retry pilot policy and result in `hold`. `pass` also requires lower assisted token, cost, and
elapsed totals on complete equal-correct validator pairs. Any visual/mixed call, wrong definite verdict on an insufficient held-out case,
held-out provider-quality failure, or assisted validator quality regression is `hold`.
Missing pairs, unknown receipts, or no measured saving is `inconclusive`. This is an offline calculation
over asserted experimental inputs. Passing unit fixtures or a local `pass` result
does not demonstrate a real workflow gain; that requires retained gateway records
and independently judged paired validator runs.

Run the offline checks with:

```bash
node --test scripts/acceptance-evidence/evaluate.test.mjs
```

## Gateway-backed corpus v3

The frozen v2 adapter-only result remains a **hold**. Its evidence identifiers
(`stdout`, `response`, etc.) cannot be read by the production gateway, so no
production assessment record could satisfy the v2 evaluator. Do not rename v2
cases, make more candidate calls on them or reinterpret that result as gateway proof.

Version 3 is a new synthetic corpus with gateway-readable artifact paths and
opaque IDs. A fresh isolated reader checked the final v3 cases without a label file.
[The dated blind audit](results/v3-blind-label-audit.json) retains its prompt digest,
reader identity and [raw first-pass output](results/v3-blind-label-raw.json). The SHA-256 hashes are:

```
ba30af5bea1f9c54e2723220c658dfe0c70fe9f663d37f65380d09a5b679afe4  cases.v3.json
31ba1b52dad4186d59c6d82ce7923fb400b9bfe6c5aaac5ea7a06bd4fd59f7b1  labels.v3.json
```

`node scripts/acceptance-evidence/check.mjs` checks both frozen versions.
`TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --test scripts/acceptance-evidence/gateway-parity.test.mts`
creates temporary runs from all v3 cases and tests gateway eligibility and the
visual/mixed no-call boundary. It also uses a **fake in-process provider** to
generate 12 persisted records through the gateway methods and checks that the offline evaluator accepts
their snapshots, admissions and usage. It refuses visual/mixed analyze calls,
rejects a changed snapshot or admission, and checks that a wrong definite
answer holds while correct fake answers with equal worker arms remain
inconclusive. The fake provider gets the reference labels from this test: it
spends nothing and proves no model quality or workflow savings.

A v3 study must set `corpusVersion: 3` alongside `version: 1` when passed to
`node scripts/acceptance-evidence/evaluate.mjs <study.json>`. Every text record
must be consistent with the gateway snapshot, prepared input digest and
source digests for the recorded run, and carry the exact
synthetic admission `synthetic:acceptance-evidence-v3/<caseId>`. The older study
format with an omitted `corpusVersion` continues to select frozen v2; an
explicit `null` version is invalid. Never send IDs,
splits or reference labels to the provider. Visual and mixed cases stay no-call.

A live experiment still needs a separately verified current price and spend
cap, exact synthetic admission, complete assessment records and an independent
paired baseline/assisted validator study at equal quality. Keep each attempt
and its cost in the study. Until those results exist, **impact is unknown**.

To prepare a live **synthetic-only** study, create one temporary run per case
with its criterion in `inputs/handoff.json`, a matching `AC-1` entry in
`artifacts/acceptance-status.json`, and each named evidence file under that
run's task directory. Preview `acceptanceEvidenceGet` and place its exact
`runId`, `criterionId`, and `snapshotHash` in the opt-in
`acceptance-evidence-policy.json` with `classification: synthetic` and
`sourceRef: synthetic:acceptance-evidence-v3/<caseId>`. Set a verified price
and per-batch spend/call limits before analyzing. Page through
`assessment.list({ consumer: 'acceptance-evidence', limit: 100, before })` for
the run owner, passing each `nextCursor` as `before` until none remains.
Keep every record for the study's 12 run IDs, including failed and repeated
attempts, and exclude unrelated runs. Export those records unchanged into
`assessmentRecords` and link each record ID to its case. Check that the run
set and export are complete before evaluation; omitted attempts make costs
and policy compliance unknowable. Capture paired worker judgments and full
workflow time/tokens/cost separately; an assessment record cannot supply
those measurements. The gateway parity test shows the exact file shapes and
uses a temporary home so it does not alter real runs. Its isolated tmux
startup may log a harmless deferred-options message because it has no server.

The offline hash and digest checks compare fields within the retained record
against the frozen packet. They cannot authenticate who created a JSON export;
retain the gateway history export unchanged and verify provenance separately.
The small synthetic corpus may not distinguish models with similar accuracy.
A pass here does not repair the v2 false-positive verdict or show production
accuracy, and the separate paired study is required for an efficiency claim.
