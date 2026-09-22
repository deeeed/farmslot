# Structured assessment evaluation plan

**Status:** Approved supporting plan for [ADR-061](../adr/061-structured-assessment-providers.md)
**Scope:** Farmslot gateway assessment providers and eval-package comparison

This plan validates the provider boundary before any assessment result is used
to route or review real work. Recipe planning remains in `mm-harness`.

## Opt in locally

Set the key in the gateway's execution environment. A key alone does nothing.
Enable the feature and select a provider explicitly:

```bash
export TYPESAFE_API_KEY="..."
export FARMSLOT_ASSESSMENT_ENABLED=true
export FARMSLOT_ASSESSMENT_PROVIDER=typesafe
export FARMSLOT_ASSESSMENT_MODEL=jev-1.13.0
```

The equivalent persisted file is `~/.farmslot/assessment-config.json`. It must
contain only `enabled`, `provider`, `model`, `timeoutMs`, and `maxStateBytes`.
Use the gateway-local commands to inspect and test the setup:

```bash
cd apps/command-center
yarn farmslot rpc assessment.status '{}'
yarn farmslot rpc assessment.test '{"provider":"typesafe","model":"jev-1.13.0"}'
```

`assessment.status` never calls the provider. `assessment.test` sends only a
synthetic color question. Missing credentials return `skipped`; an upstream
failure returns `unavailable`; neither changes a run.

## Review-intake pilot

Run the same static PR intake corpus twice:

1. control: assessment disabled;
2. candidate: assessment enabled with a pinned provider/model.

The candidate receives only PR identity, title, and an allowlisted set of
normalized facts. It does not receive the head SHA, existing review
observations, or screenshots. The advisory
classifies risk, visual-review need, and a review surface. It is attached to the
preview item and never changes `match`, execution, review profile, admission,
publication, or merge state.

Compare against a human/strong-model reference for:

- risk classification accuracy;
- visual-review recall, with false negatives counted as blocking;
- uncertain-routing recall;
- latency, input/output tokens, and provider cost;
- behavior when the provider is disabled, unavailable, over size limits, or
  returns malformed typed answers.

Create one Reference result package for the existing review corpus and one
Candidate package for the assessment-assisted lane. Add an `assessment` axis
to the candidate strategy and use the `structured-assessment` scorer kind for
the advisory comparison. Keep the packages artifact-only and do not publish
PR comments from this experiment.

## Exit criteria

The pilot is useful only if it improves visual-review recall or routing quality
without increasing false approvals, and the normal disabled path remains
byte-for-byte behaviorally unchanged. A low-confidence or unavailable answer
must route to the stronger reviewer path, never to a cheaper one. If the
reference comparison does not show a useful gain, keep the provider adapter
available for explicit experiments but do not enable it in review defaults.
