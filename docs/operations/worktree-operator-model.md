# Worktree Operator Model

**Owner:** Arthur / Farmslot
**Relates to:** [ADR-039](../adr/039-run-portable-bundles.md), [README.md](../../README.md#development-multi-worktree)

## Canonical planes

| Plane | Path / ports | Purpose |
| ----- | -------------- | ------- |
| **Main operator** | Primary clone, gateway `7777`, UI `5174`, Companion `local` | Canonical `.runs/` history, real dispatches/evals |
| **Worktree sandbox** | `farmslot-wt/farmslot-{n}` (`macwork-ff-*`), gateway `8808+` | `project: farmslot-farm`, `platform: cli`, profile `sandbox` by default |
| **Companion (on demand)** | Same slot + worktree | Optional `resources.ios-sim` (`fs-{n}`); boot sim + Metro only via `companion-warm`, `companion-full`, or `sandbox-companion` — never a separate `fc-*` farm |

**Unification rule:** all first-party slots share `farmslot-{n}` worktree naming. Do not add `farmslot-companion-*` repos, `macwork-fc-*` slot IDs, or `app: companion` on pool slots. Cross-surface tickets use `sandbox-companion` on one slot.

## Seed a sandbox from main

```bash
# Main — export a run or whole family (reference profile is the default)
cd /Users/deeeed/dev/farmslot
farmslot runs export <runId> -o /tmp/baseline.farmrun
# or
farmslot runs export --family-id <familyId> -o /tmp/family.farmrun

# Worktree sandbox — import writable copy (new run IDs)
cd /Users/deeeed/dev/farmslot-wt/farmslot-<n>
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