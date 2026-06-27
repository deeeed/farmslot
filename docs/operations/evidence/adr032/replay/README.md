# ADR-032 merge-process replay evidence

Historical PRs #81–#86 were merged without pre-merge independent GitHub `APPROVED` reviews
(`deeeed` approvals landed post-merge). Strict merge-process verification uses only frozen
files in this directory produced by `scripts/capture-pre-merge-evidence.sh` immediately before
a replay PR merge.

Populate via one replay PR: cross-review loop → `capture-pre-merge-evidence.sh` → merge →
freeze `pr81-premerge-capture.json` and `pr81-postmerge.json` here.