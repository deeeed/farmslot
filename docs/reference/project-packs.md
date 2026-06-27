# Project Packs

A project pack is the unit of project onboarding: a directory (local path or git
repo) that `farmslot project add <source>` turns into registered projects,
cloned repos, and validated pool slots.

## Layout

```
my-pack/
  pack.json                      # pack manifest (required)
  projects/<name>-farm/          # one or more project dirs, standard layout
    project.json                 # per schemas/project.schema.json
    setup/<platform>.sh          # required one-time slot bootstrap (run by setup-slot.sh)
    fixtures/                    # optional fixture templates
    templates/                   # optional task templates
  hooks/                         # optional pack hook scripts
```

## pack.json

```json
{
  "name": "my-pack",
  "description": "What this pack farms.",
  "projects": [
    {
      "dir": "projects/my-app-farm",
      "platform": "cli",
      "slots": 2,
      "short": "my-app",
      "repo_url": "git@github.com:you/my-app.git"
    }
  ],
  "hooks": {
    "pre_add": "bash hooks/pre-add.sh",
    "post_add": "bash hooks/post-add.sh",
    "sync": "bash hooks/sync.sh",
    "smoke": "bash hooks/smoke.sh"
  },
  "action_sheet": "Printed after a successful add — operator next steps."
}
```

| Field                 | Required | Meaning                                                                                        |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`                | yes      | Kebab-case pack id; key in workspace `state.json`.                                             |
| `projects[].dir`      | yes      | Project dir inside the pack (`projects/<name>`); basename must equal `project.json` `name`.    |
| `projects[].platform` | yes      | Slot platform (`cli`, `web`, `ios`, ...).                                                      |
| `projects[].slots`    | yes      | Default slot count created on add.                                                             |
| `projects[].short`    | no       | Short name for slot ids/sessions; defaults to the project name minus a `-farm` suffix.         |
| `projects[].repo_url` | no       | Product repo to clone per slot; overrides `project.json` `repo_url`. Supports `{{workspace}}`. |
| `hooks.*`             | no       | Shell commands run with cwd = pack dir (see below).                                            |
| `action_sheet`        | no       | Text printed after a successful add.                                                           |

Note: a project.json `$schema` like `../../schemas/project.schema.json`
resolves once the dir is registered into the farmslot clone, not in the pack
source — editor validation works after `project add`.

## Hooks

All hooks run with cwd = the pack directory and env:

- `FARMSLOT_WORKSPACE` — workspace root
- `FARMSLOT_DIR` — the workspace farmslot clone
- `FARMSLOT_REPOS_DIR` — `<workspace>/repos`

Hook commands run through `bash -c` and the slot lifecycle shell — avoid single
quotes in workspace, repo, and hook paths.

| Hook       | When                                                              |
| ---------- | ----------------------------------------------------------------- |
| `pre_add`  | Before product repos are cloned (e.g. seed a local fixture repo). |
| `post_add` | After slots are created and validated.                            |
| `sync`     | During `farmslot update`, when the pack content hash changed.     |
| `smoke`    | Last step of `project add`; non-zero exit fails the add.          |

## What `project add` does

1. Resolve the source (local dir, or git URL cloned under `<workspace>/packs/`).
2. Validate `pack.json` + each project dir against the contract above.
3. Decide: new pack → add; same content hash → no-op (re-verify); changed → repair.
4. Verify every declared project has `setup/<platform>.sh`; missing setup
   scripts fail early before product repos or slots are mutated.
5. Run `pre_add`.
6. Copy project dirs into the workspace farmslot `projects/` (applying
   `repo_url` overrides).
7. Per slot: blobless-clone (`--filter=blob:none`) the product repo into
   `<workspace>/repos/<short>-<n>`, register the slot in the machine pool file
   (ports allocated from 9300+; existing slots are never clobbered), then run
   the existing lifecycle scripts: `sync-fixtures.sh`, `setup-slot.sh`, the
   project `preflight` hook, and `preflight-slot.sh` (validation).
8. Run `post_add`, then `smoke`.
9. Record the pack (source, content hash, projects, slots) in workspace
   `state.json`, print the action sheet, and finish with `farmslot doctor`.

`prepare-slot.sh` is not part of onboarding: it delegates to the gateway
(`slot.prepare`), which is not running yet during install. Dispatch-time
prepare still owns the branch lifecycle.

Ownership rules:

- **Packs own their project dirs.** An add/repair re-copies `projects/<name>/`
  from the pack, overwriting local edits there. Persist customizations in the
  pack source, not the registered copy. (Pool files are the opposite: user
  edits are always preserved.)
- **Nothing is deleted on removal.** Slots/projects removed from a pack stay in
  the pool and `projects/` until removed manually — repair only adds or
  verifies. State ownership (`state.json`) always reflects the pack's current
  manifest, so removed entries become unowned leftovers on disk.
- Re-running `project add` with an **unchanged** pack is verify-only: no
  mutation hooks (`pre_add`/`post_add`), no setup, no re-copy. Validation
  (`preflight-slot.sh`) and the `smoke` hook still run. Missing pieces (deleted
  repo, removed slot) escalate that run to a repair automatically.

## Example

`packs/example-app/` is the reference pack: a CLI-platform project whose
`pre_add` hook seeds a tiny local fixture repo, with a fast smoke check. The
onboarding E2E (`scripts/quality/test-onboarding.sh`) runs it end to end in a
scratch workspace.

## Deferred setup and per-project adds

Use `farmslot project add <pack> --no-setup` when a pack should register projects, clone slot repos, and sync fixtures without running expensive setup/build/preflight scripts. The pack hash is intentionally left repair-needed so a later run without `--no-setup` performs the full setup.

Use `--project <name>` to add or repair one project from a multi-project pack:

```bash
farmslot project add git@github.com:Example/team-farm.git --no-setup
farmslot project add git@github.com:Example/team-farm.git --project example-extension-farm
```

`--project` accepts the project dir basename, pack `short`, or `projects/<name>` path.
