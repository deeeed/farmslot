# Static review workspaces

Configure and launch slot-free PR reviews under [ADR-058](../adr/058-static-review-and-farm-owned-qa.md). This is the operational reference for the static execution stage; existing `full-live` reviews still use runtime slots.

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

In Command Center, open **PRs → Reviews → Request review**, enter a PR URL, and choose **Static review**. A unique matching team is selected automatically. Advanced options expose execution overrides. Enable **Start when the configured resources are available** to queue execution automatically.

From a checkout, use the local CLI in `apps/command-center`:

```bash
yarn farmslot dispatch preview --project example --flow-type review-pr --ticket example/app#42
yarn farmslot run create --project example --flow-type review-pr --ticket example/app#42
yarn farmslot run create --project example --flow-type review-pr --ticket example/app#42 --review-machine review-other --effort high
```

Static requests default to autonomous mode. Preview shows capacity without starting a reviewer. Direct creation refuses a full host; queued requests retain their permitted alternatives and wait. PR automation rules use the same admission and ownership checks. Repeat workspace reviews currently start a fresh native session, retain prior findings, and record the fallback when incremental continuation was requested.

Completion, failure and a worker-reported blocker retain task artifacts and release the owned checkout and process. Unconfirmed cleanup continues to reserve capacity and exposes the cleanup error. No static worker builds, installs dependencies, runs the app or publishes a verdict. This stage retains results in Farmslot; publication policy is a separate capability.

## Existing runtime reviews

`review-pr` requests with `reviewValidationDepth: full-live` keep their slot placement and existing runtime template. The CLI accepts `--review-validation-depth full-live --slot <slot-id>`. Static farm defaults do not replace those choices.

An unstarted static request pinned to a slot requires explicit workspace configuration. The gateway does not interpret a slot pin as permission to use its host. Existing historical records keep their original execution identity.
