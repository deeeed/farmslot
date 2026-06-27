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
# Main — export reference family or run
cd /Users/deeeed/dev/farmslot
farmslot runs export <runId> -o /tmp/baseline.farmrun
# or
farmslot runs export --family-id <familyId> -o /tmp/family.farmrun

# Worktree sandbox — import (filesystem) or via gateway RPC
cd /Users/deeeed/dev/farmslot-worktrees/<branch>
farmslot runs import /tmp/baseline.farmrun --mode seed --root "$PWD"

# When sandbox gateway is running on 7778:
farmslot --url ws://localhost:7778 runs import /tmp/baseline.farmrun --mode seed
```

Import modes:

- `reference-only` — read-only stubs + packages for eval seeding (default)
- `seed` — new run IDs, writable comparison siblings
- `mirror` — preserve IDs (disaster recovery only; refused for multi-run bundles without `--force`)

## Promote candidate packages back to main

```bash
farmslot runs export <candidateRunId> --as-package /tmp/candidate.result-package.json
# Use #evals manual package reference or eval.experiment.create on main
```

Real production history stays on main unless you explicitly import with `mirror --force`.