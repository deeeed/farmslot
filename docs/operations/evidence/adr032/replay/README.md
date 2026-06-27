# ADR-032 merge-process evidence

## Goal criteria 2–3 (PR #81)

Validated by `scripts/verify-adr032-merge-process.sh` against **frozen PR #81 artifacts** in the parent directory:

- `pr81-premerge.json` — CI rollup snapshot before merge (required jobs SUCCESS, completed before `mergedAt`)
- `pr81-merge-timing-note.json` — merge timing disclosure (`mergeTimeCiGreen: true`, no `processWaiver`)
- `pr81-CROSS-REVIEW-LOOP.json` — independent cross-review completed at or before merge (`pre-merge-cross-review`)

Post-merge GitHub `APPROVED` on PR #81 (`deeeed` ~10:08Z) is **not** used as review proof; pre-merge cross-review JSON is authoritative per the timing note.

PRs #82–#86 process violations are out of scope for the PR #81 goal criteria.

## PR #89 process demo (non-goal)

`pr89-process-demo/` holds an honest pre-merge capture from PR #89 (split verifiers). It demonstrates `capture-pre-merge-evidence.sh` hygiene but does **not** substitute for PR #81 historical evidence.