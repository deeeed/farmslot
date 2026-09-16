# Static review workspaces

Configure and launch slot-free PR reviews under [ADR-058](../adr/058-static-review-and-farm-owned-qa.md). Runtime validation uses the separate [farm QA flow](farm-qa.md).

## Configure the farm

Opt each review machine into capacity in its pool configuration:

```json
"review_workspaces": { "max_concurrent": 3 }
```

The machine must belong to the project, and the authenticated requester must own its native execution node. Select a runner with managed worker and read-only workspace capabilities. A machine can provide review capacity with no device slots.

Select the project template and frozen skill sources in `project.json`:

```json
{
  "static_review": {
    "template_id": "review-pr/team-static",
    "support": {
      "skills": [
        {
          "name": "team-review",
          "root": { "env": "TEAM_REVIEW_SKILL_ROOT" },
          "entry": "SKILL.md"
        }
      ]
    }
  },
  "workflow_defaults": {
    "review-pr": {
      "execution": {
        "workspacePolicy": {
          "kind": "pool",
          "allowedMachines": ["review-host", "review-other"]
        },
        "transport": "native",
        "models": [{ "runner": "<native-runner>", "model": "<model>", "effort": "high" }]
      },
      "review": {
        "sessionIntent": "resume",
        "scope": "incremental",
        "validationDepth": "static-code"
      }
    }
  }
}
```

Replace the runner/model placeholders with a supported choice. Both listed machines need their own configured capacity. The template ID must exist in the project's execution-template catalog or its `templates/worker` directory. Template instructions invoke the configured skill and satisfy the gateway task's artifact contract. Workflow instructions remain in the skill.

Support may also declare libraries, an installed Node runtime and environment bindings. These are frozen files, not installation commands. Reports retain the reviewed commits, template digest and support provenance. Changes to the original support source do not retarget an admitted review.

PR requests inherit complete policies in this order: request, rule, repository, team, farm. Explicit machine, runner, model and effort choices must remain within the selected policy. A supplied template ID must match `static_review.template_id`.

## Launch reviews

In Command Center, open **PRs → Review / QA → Request review / QA**, enter a PR URL, and choose **Review**. A unique matching team is selected automatically. Advanced options expose execution overrides. Enable **Start when the configured resources are available** to queue execution automatically.

From a checkout, use the local CLI in `apps/command-center`:

```bash
yarn farmslot dispatch preview --project example --flow-type review-pr --ticket example/app#42
yarn farmslot run create --project example --flow-type review-pr --ticket example/app#42
yarn farmslot run create --project example --flow-type review-pr --ticket example/app#42 --review-machine review-other --effort high
```

Static requests default to autonomous mode. Preview shows capacity without starting a reviewer. Direct creation refuses a full host; queued requests retain their permitted alternatives and wait. PR automation rules use the same admission and ownership checks. Repeat workspace reviews currently start a fresh native session, retain prior findings, and record the fallback when incremental continuation was requested.

Completion, failure and a worker-reported blocker retain task artifacts and release the owned checkout and process. Unconfirmed cleanup continues to reserve capacity and exposes the cleanup error. No static worker builds, installs dependencies, runs the app or publishes a verdict. This stage retains results in Farmslot; publication policy is a separate capability.

## Existing runtime reviews

Unstarted `review-pr` requests with `reviewValidationDepth: full-live` normalize to QA using the configured farm profile. Their slot constraints and original settings remain recorded. Missing profiles or ambiguous legacy tier/recipe settings require configuration. New callers should send `flowType: qa` and a profile.

Already-running work and historical results retain their original contract. Migration does not relabel an old verdict as newly verified QA.

An unstarted static request pinned to a slot requires explicit workspace configuration. The gateway does not interpret a slot pin as permission to use its host. Existing historical records keep their original execution identity.

## PR review publication

PR-intake requests can set `review.publishReview` to true or false. Omission inherits
request/rule, repository, team and farm policy, in that order; the built-in default
keeps results in Farmslot. Publication inherits independently of session/scope choices.
Projects opt in through `workflow_defaults["review-pr"].review.publishReview`.
QA cannot enable static-review publication.

Admission freezes the publication choice, policy source, team and GitHub account.
Completed workspace reviews publish through the gateway after current owner, account,
project policy and PR-head checks. Workers retain read-only workspace permissions and artifact-only completion. Publication is a separate, explicitly requested gateway action after completion.
The body and inline findings are submitted together against the reviewed commit.
A self-authored PR receives a comment event because GitHub forbids self-approval.

The run retains the provider receipt and any publication error, including after
archival. Errors do not erase completed review results or start an endless retry loop.
An authenticated owner can retry a requested publication through
`prReview.publish` with `{ "runId": "..." }`. A lost response is reconciled by the
owned publication marker. If the outcome cannot be established, Farmslot reports
uncertainty and does not post again.

Command Center exposes inheritance and explicit publication choices in PR requests and
policy editors. Run detail shows the account, policy source, receipt link and retry errors.
Direct `run create` also captures publication policy while returning the normal Run result:

```bash
yarn farmslot run create --project example --flow-type review-pr --ticket example/app#42 --publish-review --review-team <team-id>
yarn farmslot run create --project example --flow-type review-pr --ticket example/app#42 --no-publish-review
```

`--team` aliases `--review-team`. A unique owned team mapped to the project/repository
is inferred. Ambiguous configured publication policies require an explicit team;
opt-out needs no account. Omitted publication flags inherit policy. The gateway freezes
the selection, rejects client-forged authority and revalidates it before publication.
