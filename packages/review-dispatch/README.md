# Review and dispatch selections

Shared selection state and validation for Command Center, Companion, CLI and
gateway, following the [review contract](https://farmslot.io/docs/reference/review-modes-warm-cold).
Protocol owns `ReviewSelection`, `ReviewSequence` and provenance types.

```ts
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

const picker = new ReviewDispatchViewModel({
  context: { allowedActions: ['request-review'], allowSequence: true },
});
picker.setRunner(picker.rows[0].id, 'codex');
picker.setEffort(picker.rows[0].id, 'high');
const payload = picker.toRequestPayload();
```

The model owns defaults, catalog choices, row edits and serialization. Thin
renderers use `rows`, `catalog.runners`, `modelChoices`, `effortChoices` and
`subscribe`. Context supplies defaults, allowed actions, row limits and workflow.
Catalog helpers preserve custom model IDs and saved preferences.

`toSelection`, `toSequence`, `toRequestPayload`, `toDispatchOptions` and
`toExecutionModels` serialize the appropriate host request. Resource constraints
follow stable row IDs. Saved models and efforts preserve explicit null defaults;
`executionModelFromSelection` resolves them when execution starts.

Server and SDK callers use `assertReviewSelection`, `assertReviewSequence`,
`assertReviewRequestPayload`, `assertReviewPolicy` and `assertReviewRequestContext`.
Removed fields fail validation. Empty saved sequences clear configuration;
review requests require a first row.

WARM provenance is separate from the four choices. `ReviewRequestContext.reviewLineages`
aligns repository/PR and durable review IDs with sequence rows. Gate payloads use
`context`; primary review dispatch and PR options use `reviewContext`; additional
reviews use `reviewSequenceContext` from `toDispatchOptions`.

`reviewLineagesForRun` and `reviewLineagesForPR` collect retained session/head
provenance. The corresponding `reviewRequestContextForRun/PR` helpers bind a
specific ID or one unambiguous lineage. `setContext` preserves selections;
`setReviewContext` binds individual rows. Missing WARM context appears in `errors`
and blocks invocation. The gateway verifies ownership and eligibility.

PR alternatives set `sequenceRole: 'execution-alternatives'` and may share one
lineage, with up to 20 rows. Counted review sequences stay capped at five rows and
cannot duplicate a lineage. QA contexts set `workflow: 'qa'`;
static lineage does not block QA, and QA cannot invoke `request-review`.

`resolveReviewDispatchDefaults(project, flow, fallback, overrides)` applies stored
overrides after project defaults. Undefined fields inherit defaults; null model
and effort values remain explicit runner-default choices.

## Source layout

`src/types.ts` defines caller context; `catalog.ts` resolves supported choices.
`validation.ts` and `provenance.ts` validate selections and retained lineage.
`view-model.ts` owns rows; `execution.ts` serializes execution alternatives.
`test/review-dispatch.test.ts` covers the shared contract.

## Maintenance rules

Keep selection state and validation here. Platform renderers display this model;
callers supply resource, QA and publication context. Preserve saved custom model IDs.

## Local quality

Run `yarn workspace @farmslot/review-dispatch quality`. Build after protocol with
`yarn workspace @farmslot/review-dispatch build`.
