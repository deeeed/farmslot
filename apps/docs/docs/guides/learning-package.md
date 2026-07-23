---
title: Share run learnings
---

# Share run learnings

`@farmslot/handoff` turns a completed task's report and learnings into a
validated, scrubbed Learning Package. Capture is separate from analysis:
sharing records the run; a later process may decide whether anything should
change.

## Configure once

Local staging needs no setup. To configure sharing, create
`$FARMSLOT_HOME/handoff/learning.config.json` (default:
`~/.farmslot/handoff/learning.config.json`):

```json
{
  "schemaVersion": 1,
  "destination": "~/dev/experimental-agentic-learnings"
}
```

The destination is a local clone of the shared git repository. It is optional
until you choose to share.

## Close out a task

After the task writes `SIGNAL.json`, `artifacts/report.md`, and
`artifacts/learnings.md`, provide task-local `inputs/handoff.json` metadata:

```bash
handoff closeout <task-dir>
```

This stages locally and prints the exact destination path. It does not write to
the shared repository.

Only after a human explicitly approves that package:

```bash
handoff closeout <task-dir> --share
```

Every share requires fresh approval and writes the exact staged bytes, not a
rebuild from changed task files. Secret detection blocks sharing and keeps only
a sanitized local audit. Closeout failure never changes the task verdict.

Fleet callers pass the active farm's config with
`--config <farm-root>/handoff/learning.config.json`. Farms may share one
destination, where project/domain indexes keep packages distinct, or use
separate destinations. The caller selects the farm; Handoff has no routing map.
