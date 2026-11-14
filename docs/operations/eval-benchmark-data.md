# Read-only benchmark results

Set `FARMSLOT_EVAL_DATASET_ROOT` on the gateway to an operator-controlled dataset directory. The Eval Cockpit reads `trial-records/index.json` (`bench-trial-index/1`) and its `bench-trial/1` records. Index paths are relative to the dataset root. The RPC accepts no source paths. No trial, PR, or source file is changed. Refresh reads updated records; existing package eligibility is unchanged.

The landing groups task profile × model, keeping route and effort separate. Solved means `MATCHES-REF` or `ACCEPTABLE-ALT` versus the pre-review original. Mergeability is a separate judge assessment. Counts are trials, including repeats, with distinct-case counts shown. Unknown prices are not zero. Spending and turns include unscored attempts; infrastructure failures remain separate. Area and size are filters, not invented problem classifications.

An optional `reference-usage.json` supplies measured original-run usage:

```json
{
  "schema": "bench-reference-usage/1",
  "originals": [
    {
      "repo": "owner/repository",
      "head": "original-pre-review-head",
      "runId": "original-run-id",
      "model": "original-model",
      "scope": "initial worker through first review; excludes review and review-fix",
      "startedAt": "2026-01-01T00:00:00Z",
      "completedAt": "2026-01-01T01:00:00Z",
      "sourceSha256": "retained-source-sha256",
      "usage": {
        "costUsd": 10,
        "turns": 100,
        "inputTokens": 1000,
        "outputTokens": 500,
        "cacheReadTokens": 2000,
        "cacheWriteTokens": 0,
        "reasoningTokens": null,
        "wallMinutes": 60,
        "costNote": "Token-derived estimate, not an invoice."
      }
    }
  ]
}
```

Capture these values with the existing `@farmslot/slot-config` `runSessionUsage` timestamp-window reader and the original run's worker context. Exclude review/review-fix from the initial-output comparison, deduplicate resumed sessions, and retain the interval, transcript hash and accounting receipt. Do not substitute whole-run totals when the same session later did review fixes. The receipt matches the original's exact repository/head; duplicate matches are rejected. A missing receipt stays missing. A measured saving requires known, positive original cost and known candidate cost.

## Validation recipe

`scripts/runner-validation/eval-benchmark-read.recipe.json` reads the configured gateway through an explicit `FARMSLOT_GATEWAY_PROFILE`. It takes no mutation action. Optional `FARMSLOT_EVAL_PROOF_ITEM`, `FARMSLOT_EVAL_EXPECT_PRIMARY`, `FARMSLOT_EVAL_EXPECT_MERGED` and `FARMSLOT_EVAL_REQUIRE_ORIGINAL=1` bind the expected live claim. `FARMSLOT_EVAL_PROOF_OUTPUT` retains the JSON receipt. Run with the repository recipe runner and `scripts/runner-validation/acceptance-evidence.action-manifest.json`; browser rendering is checked separately in Command Center.

## Detailed comparison and export

Compare selects one or two trials for the same case and pinned reference. The detailed read joins the index to retained `refs/<item>-prereview.diff`, `workers/worker-<run-prefix>/diff-vs-base.patch`, worker metrics and the task's acceptance ledger. All paths stay within the configured dataset. Missing artifacts remain explicit; the view never substitutes merged output for an unavailable pre-review original.

Changed-line counts come from retained text patches, classified by test paths versus code and other files. Patch and ledger attribution requires an exact worker run ID. Diff-of-diffs additionally requires equal full 40-character base hashes. It yields between edit lengths, with a shared five-second request budget and a 1,024-edit limit per comparison; exceeding either limit leaves an explicit note and keeps the raw patches available. Selecting a file compares that file's patch on both sides. Ledger criteria remain separate from judge AC claims; findings retain cause, cited evidence and whether the original shared the issue. None of these reads creates a new grade or changes publication eligibility.

Export HTML downloads the selected comparison with every section, inline styles and snapshot hashes. It needs no running gateway or application after download and includes no scripts or external resources. The original usage interval and price-estimate note stay attached to the exported values.

The comparison recipe accepts `FARMSLOT_EVAL_COMPARE_EXPECT=verified|identity-unverified|base-unverified|budget|patch-missing`. Use a disposable, isolated dataset for negative cases. It checks missing-artifact file filtering and scope claims as well as the authenticated RPC and inert HTML export. Never alter the operator dataset for validation.
