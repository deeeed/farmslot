---
title: Review and dispatch picker
---

A review selection contains `runner`, `model`, `effort` and `mode`. COLD starts a fresh reviewer session for the whole PR diff. WARM resumes the identified reviewer session for the delta since its last reviewed head. Each separate review session qualifies regardless of runner choice.

`@farmslot/review-dispatch` owns the shared `ReviewDispatchViewModel`, catalog, validation and serializers used by Command Center, Companion, CLI and gateway. Lit and React Native each render this model. Call context supplies allowed actions, defaults, row limits and sequence availability. Effort stays next to model; unsupported adjustable effort displays its supported default.

```ts
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

const picker = new ReviewDispatchViewModel({
  context: { allowedActions: ['request-review'], allowSequence: true },
});
picker.setEffort(picker.rows[0].id, 'high');
const request = picker.toRequestPayload();
```

The `request-review` gate payload contains the first selection and an optional `sequence` of remaining rows. Dispatch and backlog store these ordered choices as `reviewSequence`. The package exports `parseReviewSelection`, `parseReviewSequence`, `parseReviewPolicy` and request-context validation for SDK and server consumers.

WARM context is separate from the four choices. `ReviewRequestContext.reviewLineages` aligns repository/PR + `reviewId` provenance with each row. Gate payloads carry it in `context`; run creation carries the primary review's `reviewContext` and the additional sequence's `reviewSequenceContext`. PR execution alternatives carry one review's context and count as one review. Missing, ambiguous, foreign or unavailable WARM lineage is refused before launch. COLD never reuses an existing session.

CLI review and dispatch use `--runner`, `--model`, `--effort`, `--review-mode warm|cold` and `--review-sequence <json>`. `--review-context <json>` and `--review-sequence-context <json>` supply lineage provenance. The run's existing `--mode` keeps its workflow meaning. QA and publication controls belong to the caller and remain separate from static review configuration.

This coordinated contract change has no aliases for old review actions, session/scope fields, worker-relative runner defaults or review-count names. Convert persisted configuration and queued requests before deployment. Historical results remain provenance until current session, reviewed-head and verdict evidence qualify them.

The accepted ADR-063 and normative contract are in the repository's `docs/adr/063-review-modes-warm-cold.md` and `docs/reference/review-modes-warm-cold.md`. Harnesses consume these typed gateway contracts and inherit validation.
