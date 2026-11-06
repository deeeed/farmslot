# Learning curation

Normative companion to [ADR-026 Amendment 2](../adr/026-self-improvement-recursive-loop.md#amendment-2-2026-11-06-curate-before-drafting).

The existing human trigger MUST run shared curation before domain drafting.
The system/template arm retains Amendment 1's policy. Input MUST use captured artifacts when
available. A worker learning is a claim, never its own corroboration.

A keep MUST cite retained evidence with run id, artifact path, line and excerpt;
confirmation by a retained accepted/fixed finding or a check by a different actor
(such as reviewer, CI or gate evidence), never the curator's own opinion; the
proposed diff-checkable instruction; the configured library content examined;
and either the same failure in two independent tasks/families or a concrete blocker-class
money/order outcome. Multiple copies, runs or review rounds in one task/family count once.
Unknown, disputed or downgraded evidence MUST fail closed. A covered rule is
dropped unless the evidence supports a specific tightening of that rule.
Unavailable source/library content MUST produce a drop reason, not a guess.

The existing gateway-owned feedback ledger MUST preserve consumption entries and
store curation outcomes separately. Each outcome binds the learning hash, source
run, destination and evidence/library digest to keep/drop, one-line reason and
verified citations. Repeated completed evaluations are idempotent. Infrastructure or malformed
provider failures are marked retryable and MUST be evaluated again after recovery. A drop MUST
NOT appear as consumption or create a hold/draft gate. An eligible entry that
cannot be drafted records the failure and uses the existing hold card. Only eligible drafts
reach the existing human gate, with their supporting evidence. No automatic
canonical-library writes or retrospective acceptance are permitted.

Counts MUST distinguish input files, entries evaluated, keep/drop, domain drafts,
draft gates and human-recorded consumption. Historical absence of evaluation
receipts MUST be reported as unknown, not as dropped. Audits may evaluate frozen
copies in an isolated gateway; those receipts are not live production history.

## Public surface

No new CLI, RPC, SDK export or flag. `@farmslot/protocol` retains the existing
request/decision contract. Gateway curation and its local ledger are internal;
the ledger stays `version: 1` with an additive `curations` array. Perps shared rules/overlays and harness
knowledge use the same router and configured destination. Coverage includes
shared rules and repository overlays. Counts appear in the existing improvement
result; unavailable libraries are recorded as infrastructure gaps. Consumers of the
consumption index MUST ignore curation records. Library materialization remains
owned by its existing generator after a human-approved library change.
