---
title: Recipe evidence loop
---

# Recipe evidence loop

A recipe connects a claim to an executed expectation and its retained evidence.
The engine owns trace and verdict derivation. The timeline owns measured recording
ranges, the artifact manifest owns file identity, and the evidence selection
manifest owns publication choices. An artifact's presence proves neither claim
coverage nor a recording timeline.

[ADR-062](https://github.com/deeeed/farmslot/blob/main/docs/adr/062-recorded-run-evidence.md)
and its [recorded-evidence specification](https://github.com/deeeed/farmslot/blob/main/docs/reference/recorded-run-evidence.md)
own the contract. The [operating loop](./operating-loop.md) explains where recipes
fit into a run.

## What establishes proof

Declare `proofTargets` and attach `proves` to an eligible assertion. The engine
uses what actually ran, including required occurrences, composition paths and
retry results. A command, screenshot, HUD caption or successful action alone is
not semantic proof. Visual criteria stay awaiting review until an engineer judges
the recording or still. Missing and failed expectations remain explicit.

The HUD is on by default and recommended where supported. Its absence alone does
not invalidate evidence or require a rerun.

## Non-UI proof

Run the relevant test through a recipe command, then assert on its result. This
example checks a project-owned script that must emit the stated success token
only when the test passes. Adjust the command and expectation to the actual claim.

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "proofTargets": [{ "id": "AC-1", "claim": "The service contract test passes." }],
  "workflow": {
    "entry": "test",
    "nodes": {
      "test": {
        "action": "command",
        "cmd": "yarn test:contract",
        "intent": "Run the service contract test",
        "next": "check"
      },
      "check": {
        "action": "assert_output",
        "source": "test",
        "contains": "contract test passed",
        "proves": ["AC-1"],
        "intent": "Confirm the contract test reported success",
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Today `command` alone and `assert_file contains` are not proof-eligible. The
approved expansion of file assertions remains implementation work. Existing
`assert_output`, `assert_json` and eligible `ui.wait_for` assertions supply
observation-bound expectations.

## Reading a recorded package

The review-model helpers are experimental source exports. Published adapter-sdk
0.9.1 includes the reader and validator, but not this new model. Use the approved
merged source or wait for a release that includes it; no new package pin is implied.

Use `readRecordedEvidencePackage(artifactDir)` from `@farmslot/adapter-sdk` in
Node. Reject failed `checks` before passing the canonical package to
`createEvidenceReviewModel` from `@farmslot/adapter-sdk/evidence`. The portable
model validates package facts and projects claims, occurrences, moments, errors
and warnings. Consumers use the existing artifact transport and player; they do
not parse a second package or infer validity from file extensions.

Recorded recipe claims require schema 2. A schema-1 task ledger has no measured
moments and is not a recorded package. Legacy task criteria, ledger and links can
remain visible without fabricated timing. Invalid or missing data stays visible
as a caption, and summary totals do not become verified proof merely because a
ledger was supplied.

## Review and retained results

The gateway freezes the approved package inventory and selection. Reports retain
path, digest and manifest identity; report prose cannot derive claim verdicts.
Selected measured clips use the canonical segment ranges and padding. Untimed or
partly covered claims remain visible without invented seeks.

Shared review curation and saved results shipped in PRs
[#963](https://github.com/deeeed/farmslot/pull/963) and
[#985](https://github.com/deeeed/farmslot/pull/985). The accepted completed-evidence,
chapters and storage-footprint design remains pending implementation. Its target
is a read-only final decision snapshot, with media availability separate from the
historical verdict and lightweight metadata retained for the run's history.
