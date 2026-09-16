# Farm QA

QA validates runtime behavior. Static Review inspects source in a slot-free workspace. Their requests and results are separate under [ADR-058](../adr/058-static-review-and-farm-owned-qa.md).

## Configure profiles

A farm profile selects a shared execution-template catalog entry and inputs. The skill owns change discovery and recipe selection. Configure profiles in `project.json`:

```json
"qa": {
  "default_profile": "pr",
  "profiles": [
    { "id": "pr", "title": "PR changes", "template_id": "qa/shared", "inputs": { "scope": { "kind": "pr" } } },
    { "id": "daily", "title": "Daily changes", "template_id": "qa/shared", "inputs": { "scope": { "kind": "window", "ref": "origin/main", "hours": 24 } } }
  ]
}
```

Use input names understood by the selected skill. These scope examples are conventions of that skill, not a framework workflow language. Configure runtime placement and models separately under `workflow_defaults.qa.execution`, using the existing slot policy. Static review machine policies cannot place QA work.

Inputs under `qa.profiles[].inputs` belong to that profile. Inputs under `workflow_defaults.qa.review.qaInputs` are farm-wide defaults applied to every QA profile, including automatic QA. Keep profile-specific values such as a release scope in the profile itself. Request inputs override matching top-level farm defaults.

## Request validation

In Command Center, use **Run QA** on a PR or select **QA** in Dispatch. Choose a farm profile. PR requests expose **QA inputs** for refs, dates or other skill inputs; invalid JSON prevents submission. Runtime validation is an explicit action by default.

From the checkout-local CLI in `apps/command-center`:

```bash
yarn farmslot dispatch preview --project example --flow-type qa --ticket example/app#42 --qa-profile pr
yarn farmslot run create --project example --flow-type qa --ticket 'Daily changes' --qa-profile daily
```

Both commands accept `--qa-inputs '<JSON object>'`. Input overrides replace matching top-level keys, so supply a complete nested scope when changing it. A queued request cannot silently acquire new inputs or a changed template before launch.

## Automatic QA

A farm can opt in with `qa.after_review: { enabled: true, profile_id: "pr" }`.
The review snapshots that profile, inputs and execution defaults at admission. Completed
reviews create one linked QA request; current ownership, project policy and PR head must
still match. Changed or disabled policy blocks the request and records the reason.
Archiving the review preserves the follow-up and its source authority, including across
restarts. It does not return the review to the active run list. Cancel the QA request to stop it.
Reviews admitted without the opt-in are never backfilled.

## Evidence and completion

The task retains its selected profile and inputs in `inputs/qa.json`. The skill freezes the change scope, chooses recipes, executes runtime smoke and records coverage. PR-bound QA pins the target commit; the skill freezes the baseline required by the selected profile.

Completion checks `artifacts/qa-result.json`, the referenced Recipe v1 suite and full recipe packages. The result identifies the run, inputs, source commits, package directories and smoke case. Package summaries must match the suite's recorded digests. Missing smoke, failed assertions, missing packages or unexecuted cases block completion even if the worker reports success. Force-complete cannot bypass this evidence gate.

QA does not publish a PR review. Preserve blocked evidence, fix the runtime or request inputs, then retry through the normal run controls.

The QA result retains the resolved change-scope artifact through `scope.path` and its canonical
JSON `scope.digest`, plus `scope.suiteDigest` for the declared recipe suite. Completion checks
both digests and requires the scope artifact's base/head to match the reported source.
Skills continue to own PR, range and time-window selection.
