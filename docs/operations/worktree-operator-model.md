# Worktree Operator Model

**Owner:** Arthur / Farmslot
**Relates to:** [ADR-039](../adr/039-run-portable-bundles.md), [ADR-042](../adr/042-slot-tracking-branches.md), [README.md](../../README.md#development-multi-worktree)

## Canonical planes

| Plane                     | Path / ports                                                 | Purpose                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Main operator**         | Primary clone, gateway `7777`, UI `5174`, Companion `local`  | Canonical `.runs/` history, real dispatches/evals                                                                                                            |
| **Worktree sandbox**      | `farmslot-wt/farmslot-{n}` (`macwork-ff-*`), gateway `8808+` | `project: farmslot-farm`, `platform: cli`, profile `sandbox` by default                                                                                      |
| **Companion (on demand)** | Same slot + worktree                                         | Optional `resources.ios-sim` (`fs-{n}`); boot sim + Metro only via `companion-warm`, `companion-full`, or `sandbox-companion` — never a separate `fc-*` farm |

**Unification rule:** all first-party slots share `farmslot-{n}` worktree naming. Do not add `farmslot-companion-*` repos, `macwork-fc-*` slot IDs, or `app: companion` on pool slots. Cross-surface tickets use `sandbox-companion` on one slot.

## Dispatch control plane vs slot validation stack — HARD RULE

`macwork-ff-*` names a **slot** (worktree repo + tmux + pool port). It is **not** the WebSocket URL you dispatch against.

Two different gateways exist on purpose:

| Gateway                      | Port (ff-2 example)                | Role                                                                                                                       |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Operator / control plane** | `7777` on `~/dev/farmslot`         | `run.create`, monitor, gate, canonical UI `5174`, `.runs/` orchestration                                                   |
| **Slot validation stack**    | `8809` on `farmslot-wt/farmslot-2` | Started by prepare profile `sandbox` — isolated Vite UI (`5876`) + gateway for **recipe/CDP probes** against that checkout |

**Always dispatch from the operator tree:**

```bash
cd ~/dev/farmslot/apps/command-center
yarn farmslot run create --project farmslot-farm --slot macwork-ff-2 ...
# default ws://localhost:7777 — do NOT pass --url ws://localhost:8809
```

Prepare on `macwork-ff-*` still runs git/tmux in the **worktree** and calls `sandbox-dev.sh start --gateway-port {{port}}` so recipes and `recipe-doctor` can target `http://localhost:5876` and `http://127.0.0.1:8809`. That slot port is for **validation**, not for replacing the operator gateway.

**Common agent mistake:** seeing `--gateway-port 8809` in recipe/E2E docs and running `yarn farmslot --url ws://localhost:8809 run create`. That binds the run engine to the sandbox process — operator UI on `5174` will not track it cleanly even when `.runs/` is shared on disk.

**When `--url ws://localhost:8808+` is correct:** importing runs into an isolated sandbox, debugging that sandbox gateway directly, or slot-local tooling — not normal `run.create` for `macwork-ff-*` smoke/E2E.

## Idle state (tracking branches)

Linked worktrees cannot checkout `main` when the primary clone has it checked out. Per [ADR-042](../adr/042-slot-tracking-branches.md), an **idle** sandbox slot stays on a **tracking branch** (today `wt/ff-1` … `wt/ff-4`) with `HEAD` equal to `origin/main` — not on `main` by name.

After `slot.release` or **force** `slot.refresh`, the gateway resets the tracking branch to `origin/main` without `git checkout main` (ADR-042). Safe refresh on an already-idle tracking branch fast-forwards `HEAD` to `origin/main` without switching branch names. If recycle looks wrong, verify idle state manually:

```bash
cd /Users/deeeed/dev/farmslot-wt/farmslot-2
git fetch origin main
git rev-parse HEAD origin/main   # must match
git branch --show-current        # wt/ff-2 (or configured tracking branch)
```

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

| You want…                                                         | Command                                            |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| Writable sandbox copy for comparisons / `prior-run` (usual case)  | `farmslot runs import <bundle>`                    |
| Packages + read-only stubs only (no relaunch)                     | `farmslot runs import <bundle> --read-only`        |
| Preserve original run IDs (disaster recovery; avoid in worktrees) | `farmslot runs import <bundle> --keep-ids --force` |

Protocol/RPC names (`seed`, `reference-only`, `mirror`) and `--mode` remain for scripts but are hidden from primary CLI help.

### Export flags (human surface)

| You want…                                      | Command                                                  |
| ---------------------------------------------- | -------------------------------------------------------- |
| Baseline for eval / worktree seeding (default) | `farmslot runs export <runId> -o out.farmrun`            |
| Whole comparison family                        | `farmslot runs export --family-id <id> -o out.farmrun`   |
| Support / forensic dump                        | `farmslot runs export <runId> -o out.farmrun --forensic` |

## Promote candidate packages back to main

```bash
farmslot runs export <candidateRunId> --as-package /tmp/candidate.result-package.json
# Use #evals manual package reference or eval.experiment.create on main
```

Real production history stays on main unless you explicitly import with `--keep-ids --force`.
