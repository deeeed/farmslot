# Evaluate textual acceptance evidence

`farmslot-agent ac` owns the verdict in `artifacts/acceptance-status.json`. Structured assessment gives a separate, opt-in opinion about one recorded criterion and its identified textual evidence. It cannot update the ledger or inspect screenshot pixels. The [frozen synthetic study](../../scripts/acceptance-evidence/README.md) defines the initial rubric, labels and unassisted baseline.

Enable `FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED=true` and `FARMSLOT_ASSESSMENT_ENABLED=true`; configure `FARMSLOT_ASSESSMENT_PROVIDER`, `FARMSLOT_ASSESSMENT_MODEL` and the provider credential in the gateway process. Credentials and provider settings alone never trigger an assessment. Use the repository's gateway client:

```bash
node apps/command-center/scripts/cdp.mjs gateway acceptance.evidence.get '{"runId":"RUN_ID","criterionId":"AC-1"}'
```

The read-only response identifies the criterion and the exact named text files to be assessed. Before admitting a request, review **all** returned text for export approval. A `manual` label does not make a company run public. The gateway excludes visual or mixed criteria, images and unsupported file types; an allowed text file can still contain sensitive content. Copy the snapshot hash into an operator-maintained `$FARMSLOT_HOME/acceptance-evidence-policy.json` with the source classification, reference, and verified provider/model price:

```json
{
  "version": 1,
  "price": {
    "version": 1,
    "provider": "PROVIDER_ID",
    "model": "MODEL_ID",
    "verifiedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
    "source": "https://provider.example/pricing",
    "inputUsdPerMillion": 1,
    "outputUsdPerMillion": 0,
    "maxInputTokens": 8192,
    "maxOutputTokens": 2048
  },
  "limits": { "maxCalls": 1, "maxUsd": 0.01 },
  "entries": [
    {
      "runId": "RUN_ID",
      "criterionId": "AC-1",
      "snapshotHash": "EXACT_SNAPSHOT_HASH",
      "classification": "synthetic",
      "sourceRef": "synthetic:case-reference"
    }
  ]
}
```

**The prices and bounds are placeholders.** Verify and replace them before use. Set `classification` to `public` only for an actual public source with an HTTPS `sourceRef`; do not relabel company data as synthetic. Paid output requires a provider adapter that enforces an output-token cap in its request, with the configured price ceiling at least that large. The existing Responses-compatible LLM adapter caps output at 2048 tokens; adapters without a cap can use only zero-priced output. Pricing older than seven days, a missing credential, a changed snapshot or text too large for the configured input-token ceiling prevents a call. The gateway reserves the whole input ceiling and allows extra room for provider instructions and tokenization; use a larger verified ceiling for longer evidence, within the configured spend cap. All bounded assessment consumers share the daily budget.

Call `acceptance.evidence.analyze` with the run ID, criterion ID and admitted `expectedSnapshotHash` to request one assessment. It returns `supported`, `contradicted` or `insufficient`, or an explicit skipped/unavailable status. A repeated request for the same snapshot and provider/model returns the saved record rather than making another call. Use `assessment.list` with `{"consumer":"acceptance-evidence"}` and `assessment.get` for the answer, evidence provenance, provider/model, attempted calls, usage, unknown charges and feedback. A saved answer remains an opinion; compare it with the unassisted validation baseline at equal correctness before claiming time or token savings.
