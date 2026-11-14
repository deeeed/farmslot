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
