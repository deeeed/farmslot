# ADR-061: Structured assessment providers

**Status:** Accepted
**Date:** 2026-09-22
**Owner:** Farmslot maintainers
**Scope:** Gateway intelligence, review intake, eval scoring, and protocol provenance
**Related:** [ADR-014](014-llm-provider-abstraction.md), [ADR-029](029-production-logging-intelligence-evidence.md), [ADR-030](030-replay-provenance-and-reference-evals.md), [ADR-058](058-static-review-and-farm-owned-qa.md)

## Context

Farmslot already has a provider abstraction for text generation in
`services/gateway/src/llm`. That contract assumes a model returns text which a
caller may render or parse. Some useful models answer a different kind of
question: they evaluate typed questions against a bounded state and return
choices, scores, boolean probabilities, and confidence.

Recipe planning is already owned by `mm-harness`, which has the action catalog,
recipe library, adapter variants, and the optional recipe advisor. Farmslot
must not duplicate that domain logic. Farmslot does need a general way to use
structured assessments for gateway-owned routing and review intake.

Visual proof is another boundary. A structured assessment provider that does
not receive images cannot validate screenshot pixels. It may identify that an
acceptance criterion needs visual review or assess textual observations, but a
multimodal reviewer, deterministic image comparison, or a human must decide
whether the visual claim is proven.

## Decision

Add a provider-neutral **structured assessment** contract beside the existing
text-model contract. The abstraction is based on capabilities rather than a
vendor or model name:

- `choice`: select one value from a closed set;
- `score`: evaluate an ordered rubric;
- `boolean`: return a true/false judgment or a native probability;
- confidence and probabilities are optional native metadata, not calibrated authority. A regular language model must not fabricate them to satisfy the interface.

The gateway contract has four parts:

1. An `AssessmentProvider` interface accepts bounded JSON state and typed
   questions, then returns validated typed answers plus usage and provenance.
2. A provider registry declares the provider id, supported question types,
   model selection, credential environment variable, timeout, and size limits.
3. An assessment policy resolves explicit CLI, environment, project, and
   operator settings. A credential never enables the feature by itself.
4. An assessment artifact records status (`disabled`, `skipped`, `unavailable`,
   or `completed`), provider/model identity, returned model version, question
   schema hash, state hash, confidence/probabilities, latency, usage, and
   request id. Raw state is not retained by default.

The TypeSafe adapter uses its native structured API. A Responses-compatible
language-model adapter turns the same questions into a prompt and JSON schema,
then validates and normalizes the answers. Provider implementations own their
transport and credentials. Consumers use the common contract and configured
provider/model identity. There is no implicit provider or model fallback.

Choice vocabularies are independent of probability distributions. Plain boolean
judgments carry a boolean value; existing probability-only records retain their
threshold behavior. Native distributions remain available without being
required from every model. Each consumer still needs an evaluation for the
selected provider/model; interface compatibility does not establish accuracy.

Assessment results are advisory. They cannot:

- replace deterministic runner hooks or structured gateway state;
- mark a visual acceptance criterion proven;
- replace an Opus/Astra or human line-by-line PR review;
- publish a review, request changes, merge, retry, or mutate a run by
  themselves.

The initial PR-metadata intake experiment did not demonstrate value and its
automatic invocation was removed. PR matching remains deterministic. The first
shipped consumer is opt-in advice for recorded failures. Textual evidence,
static checklists, copilot context and meaningful review routing require
separate evaluations before rollout.

`mm-harness` remains the owner of recipe planning. Farmslot forwards optional
advisor configuration and stores/displays the harness's recipe-plan and
recipe-advice artifacts; it does not call the assessment provider to discover
MetaMask actions or recipes itself.

## Security and data handling

The feature is off unless an operator explicitly enables an assessment
provider. Provider credentials stay in the execution host's secret environment
or Farmslot credential store and never enter project JSON, task files, or
artifacts. Each consumer supplies an allowlisted state builder with redaction,
bounded size, and timeout rules. Provider retention and zero-data-retention
claims must be verified against the provider's current terms before sending
company data.

Provider failures and low-confidence answers leave the normal workflow in
control. There is no silent fallback from a typed assessment to a text model or
the reverse.

## Consequences

- Gateway consumers can use cheap structured decisions without coupling to a
  vendor SDK or model name.
- Eval packages can compare assessment-assisted and baseline runs with the
  same provenance model already used for text models.
- Command Center can show assessment status and confidence without presenting
  an advisory result as proof.
- Provider-specific adapters and policy tests add a small maintenance cost.
- Recipe authoring stays in one place, so Farmslot and `mm-harness` do not
  drift apart.

## Implementation order

1. Add protocol types, provider registry, auth resolution, redaction, budget,
   timeout, and artifact provenance.
2. Add the first adapter and a read-only provider health check.
3. Add review-intake/routing as an opt-in advisory lane.
4. Add non-visual evidence triage and an eval scorer only after labeled
   comparisons against human/strong-model references.
5. Add Command Center inspection and family comparison surfaces if real runs
   show that operators need them.

## Non-goals

- A second recipe planner in Farmslot.
- A generic chat or text-generation replacement.
- Image understanding in a provider that does not accept images.
- Automatic publication, merge, retry, or run mutation from assessment output.
- Treating confidence as a calibrated probability across providers.
