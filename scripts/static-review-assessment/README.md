# Static-review checklist pilot

Scope: [the approved structured-assessment plan](../../docs/plans/structured-assessment-evaluation.md), static-review checklist consumer. This is a text-only, synthetic study. It cannot replace a full PR review, prove a visual claim or publish a finding. A model result is advice for a reviewer, never a review verdict.

The 12 invented patches cover one checklist item each: four development and eight held-out cases, balanced across `violation`, `satisfied`, `not-applicable` and `insufficient`. A definite violation must cite a changed line. `satisfied` requires complete relevant context; a call to an omitted helper is insufficient. Instructions inside code or test output are untrusted. The v1 cases and author labels were pinned **before provider calls**:

```
59a0e831d76cbec9829a2ab67d7a1d2cdefb97bea09584add86a8561c2b4fdb2  cases.v1.json
539dbe9225e106f969965d52c1b5fc0313a75e6f9f5275b32759683b99f7a77d  labels.v1.json
```

One blind local CLI read, requested as Opus, matched all 12 v1 verdicts and flagged that both L1 and L2 in the version-check case identify the defect. The response did not report its returned model identity; the read is operator evidence, not provider-authenticated proof. It also reported 124,919 cache-creation input tokens, so do not repeat that CLI route for this pilot. Before any candidate call, v2 retained the same case text and made the two causal locations acceptable. V1 remains pinned for the audit; the **active** hashes are:

```
9b8048e47eb56efdcd575f181feb7230f4a2349681e2177cd5365ed5cf0a5bd3  cases.v2.json
ae44bedd2065aad140585b8bafa50ba84c5f6d059bd819d83f5221a075856fbc  labels.v2.json
```

`node scripts/static-review-assessment/check.mjs` checks the hashes, balance, bounded input and absence of case IDs, split and rationales from `packet(entry)` on v2. The blind read is a separate check of the authored labels; the returned model version and review conditions are not independently attested. Resolve any new disputes **before** candidate calls. If a case, label, rubric or split changes, version and re-hash it first; do not silently tune a held-out case after seeing a model answer.

A no-advice reviewer baseline reading the same packets and a matched real review task are still missing. The gateway/provider study must retain every attempt, source admission, provider/model version, input digest, answer, selected changed-line ID, rejected or missing output, usage, known or unknown cost and elapsed time. A result without a matching gateway receipt does not establish a provider call. The first live batch admits only these exact synthetic inputs and is opt-in: verify current pricing and output bounds, reserve each call, no retry or fallback, at most 12 calls and USD 0.01 total. A new batch needs a new declared budget and receipt set. No MetaMask diff, private checklist, credential, screenshot or tmux output is admitted by this fixture.

`node scripts/static-review-assessment/score.mjs <gateway-record-export.json>` computes the confusion matrix and cost from retained records whose admitted synthetic source, requested model and packet digests match this corpus. It marks repeated, missing or unaccounted attempts as ineligible. The export must contain all records for this owner and batch; the scorer cannot prove its completeness or authenticate the provider. `classificationCandidate` is only a calculation against the author labels, not a pilot pass. The one-shot `pilot.mjs` path now records this synthetic consumer through the gateway assessment store; there is no operator/worker review RPC yet.

`packet()` sends one combined closed-choice question: the verdict and, for a violation, its changed-line ID. Questions are independent at the provider, so a separate location question cannot depend on another answer. The rubric was updated to this form before the first candidate call. The retained v2 case and label hashes did not change.

To exercise the gateway store without a provider call:

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/static-review-assessment/pilot.mjs --fixture --out static-review-v3-fixture
```

The live path requires `--live --out <new-name> --admit <cases.v2.json hash> --price-file <verified-price.json>`. The price JSON supplies `provider`, pinned `model`, official HTTPS `source`, `verifiedAt` within 24 hours, input/output USD per million tokens, `maxInputTokens` and `maxOutputTokens`. It rejects a missing credential, unadmitted input, unknown price, paid output without a provider-enforced cap, a reused output directory or a batch reservation above USD 0.01. The provider registry supports either structured adapter if its capabilities and price pass the same gate. `--export --out <name>` re-reads receipts from an existing isolated home without another request. Never relaunch a partial batch to fill in weak answers.

The [September 24, 2026 gateway export](results/v3-typesafe-gateway-receipts.json) contains 12 TypeSafe `jev-1.13.0` calls, no repeated or unknown attempts, 8/8 correct held-out and 4/4 correct development judgments, and both held-out violation locations accepted. The scorer recomputes 7,063 input tokens, 737 output tokens, 7,829 ms total end-to-end time, estimated USD 0.000296646, and a USD 0.004128768 reservation ceiling from the recorded price. This small synthetic pass is **classification evidence only**. The receipt export cannot authenticate its own provider traffic or prove savings. The independent CLI read's returned model was not attested. Do not enable routine static-review calls.

The predeclared classification gate for held-out cases is at least 7/8 correct, both violation locations correct, and no confident `violation` or `satisfied` on an `insufficient` reference. Report the four-class confusion matrix, coverage, abstentions, false findings and missing calls even when the gate fails. A matching strong reviewer or human reference must validate label quality; authored labels alone cannot establish a pass. Pair assisted and unassisted review tasks against the **same** frozen PR head, rubric and reviewer configuration. Have an independent reviewer adjudicate findings without knowing the lane; record full reviewer tokens, assessment tokens, charges, elapsed time and exclusions. Report efficiency as unknown until equal-quality matched pairs exist. A good synthetic classification score alone never enables routine static-review assessment.
