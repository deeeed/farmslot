# Worktree Operator Model

**Owner:** Arthur / Farmslot  
**Relates to:** [ADR-039](../adr/039-run-portable-bundles.md), [README.md](../../README.md#development-multi-worktree)

## Canonical planes

| Plane | Path / ports | Purpose |
| ----- | -------------- | ------- |
| **Main operator** | Primary clone, gateway `7777`, UI `5174`, Companion `local` | Canonical `.runs/` history, real dispatches/evals |
| **Worktree sandbox** | `farmslot-worktrees/*`, `.env.ports` → `7778` / `5175` | Gateway/eval code validation with seeded references |

## Seed a sandbox from main

```bash
# Main — export a run or whole family (reference profile is the default)
cd /Users/deeeed/dev/farmslot
farmslot runs export <runId> -o /tmp/baseline.farmrun
# or
farmslot runs export --family-id <familyId> -o /tmp/family.farmrun

# Worktree sandbox — import writable copy (new run IDs)
cd /Users/deeeed/dev/farmslot-worktrees/<branch>
farmslot runs import /tmp/baseline.farmrun --root "$PWD"

# When sandbox gateway is running on 7778:
farmslot --url ws://localhost:7778 runs import /tmp/baseline.farmrun
```

### Import flags (human surface)

| You want… | Command |
| --------- | ------- |
| Writable sandbox copy for comparisons / `prior-run` (usual case) | `farmslot runs import <bundle>` |
| Packages + read-only stubs only (no relaunch) | `farmslot runs import <bundle> --read-only` |
| Preserve original run IDs (disaster recovery; avoid in worktrees) | `farmslot runs import <bundle> --keep-ids --force` |

Protocol/RPC names (`seed`, `reference-only`, `mirror`) and `--mode` remain for scripts but are hidden from primary CLI help.

### Export flags (human surface)

| You want… | Command |
| --------- | ------- |
| Baseline for eval / worktree seeding (default) | `farmslot runs export <runId> -o out.farmrun` |
| Whole comparison family | `farmslot runs export --family-id <id> -o out.farmrun` |
| Support / forensic dump | `farmslot runs export <runId> -o out.farmrun --forensic` |

## Promote candidate packages back to main

```bash
farmslot runs export <candidateRunId> --as-package /tmp/candidate.result-package.json
# Use #evals manual package reference or eval.experiment.create on main
```

Real production history stays on main unless you explicitly import with `--keep-ids --force`.