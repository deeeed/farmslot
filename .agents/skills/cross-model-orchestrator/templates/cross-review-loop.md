# Cross-Review Loop

Coordination history only. Top-level verdict files remain authoritative for live approval.

Every self-review and paired review consumes the shared rule from `@farmslot/agent-runtime/scripts/review-diff-scope.cjs`. From the owning checkout, run `node packages/agent-runtime/scripts/review-diff-scope.cjs packet <repository> <publication-base> <head>` and include its output in each reviewer packet. Record the resulting `Diff scope` section in each verdict. The orchestrator includes this packet automatically.

For a Farmslot contribution, also read the reviewed checkout's canonical
`projects/farmslot-farm/fixtures/runtime/review-quality.md`. Each verdict includes
its per-rule applicability/outcome/evidence ledger. Confirmed applicable rule
violations block; uninspected rules remain explicit gaps. Reuse the file, do not
copy its rules into this coordination log.

## Setup

- Status: running
- Task:
- Artifact directory:
- Max cycles: 5
- Worker pane:
- Codex reviewer pane:
- Claude reviewer pane:
- Recipe/evidence review in scope:
- Reviewer command policy:

## Cycle Records

### Cycle 1

- Worker ready signal:
- Reviewed head and delta base:
- Reviewer session identities and recovery:

#### Reviewer Verdicts

- Codex reviewer: pending
- Claude reviewer: pending

#### Findings Sent To Worker

- None yet.

#### Worker Fix Summary

- Pending.

#### Validation Summary

- Pending.

## Final Verdict

- Final verdict: pending
- Stop reason:
