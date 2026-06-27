# ADR-032 merge-process replay evidence

Historical PRs #81–#86 were merged without pre-merge independent GitHub `APPROVED` reviews
(`deeeed` approvals landed post-merge). Strict merge-process verification uses only frozen
files in this directory produced by `scripts/capture-pre-merge-evidence.sh` immediately before
a replay PR merge.

Populate via one replay PR: cross-review loop → `capture-pre-merge-evidence.sh` → merge →
freeze these artifacts:

- `pr81-premerge-capture.json` — atomic pre-merge snapshot (OPEN PR, head-scoped APPROVE, CI green)
- `pr81-postmerge.json` — merged PR view after merge
- `cross-review-pr81.txt` — reviewer verdict with line `VERDICT: APPROVE` or `VERDICT: APPROVE pending CI`