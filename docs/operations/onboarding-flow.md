# Farmslot Onboarding — Install → Pack → Customize → Dispatch

A team farm is a **pack** (a repo of project configs) installed on top of the
**farmslot framework**. This page walks the full lifecycle at the framework
level: what runs, what lands where, and what you edit before dispatching real work.

## The four phases

```
  1. INSTALL          2. PACK              3. CUSTOMIZE          4. DISPATCH
  ─────────           ────────             ──────────           ──────────
  framework +         register projects,   fill secrets,        farmslot up →
  CLI + doctor        clone repos,         edit task prompts,    Command Center
                      create slots         set machine config    → agents run
```

Phases 1–2 are one `install.sh` command. Phase 3 is manual editing. Phase 4 is
day-to-day operation.

## 1. Install (the framework)

A pack ships an `install.sh` that bootstraps everything. It:

1. Pulls the pack's project submodules (each is a project config repo).
2. Copies `*.sample` fixture files → real, gitignored fixture files.
3. Runs **farmslot's own `install.sh`** (curl'd from the public repo, or a local
   override), which installs the framework, symlinks the `farmslot` CLI, and runs
   `farmslot doctor`. This installer **prompts** (in an interactive terminal) for
   the workspace / bin / home locations, with sane defaults. Piped/CI installs
   stay silent and take the defaults.
4. Runs read-only prerequisite checks.

### What lands WHERE (3 machine locations)

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  ~/dev/farmslot-workspace/          ← FARMSLOT_WORKSPACE (default)    │
  │    farmslot/        framework clone (scripts, gateway, UI, CLI)      │
  │    repos/           product repo clones — one per slot                │
  │    runs/            run archives (dispatched task history)            │
  │    state.json       onboarding / workspace state                     │
  └─────────────────────────────────────────────────────────────────────┘
                              │  symlinks the CLI ↓
  ┌─────────────────────────────────────────────────────────────────────┐
  │  ~/.local/bin/farmslot              ← FARMSLOT_BIN_DIR (default)      │
  │    single symlink so `farmslot` is on PATH                            │
  └─────────────────────────────────────────────────────────────────────┘
                              │  reads/writes state ↓
  ┌─────────────────────────────────────────────────────────────────────┐
  │  ~/.farmslot/                       ← FARMSLOT_HOME (default)         │
  │    state/           auth, pairing, doctor + star-prompt state         │
  └─────────────────────────────────────────────────────────────────────┘
```

All three are overridable via env vars (`FARMSLOT_WORKSPACE`,
`FARMSLOT_BIN_DIR`, `FARMSLOT_HOME`). If `~/.local/bin` is not on `PATH`, the
installer tells you to add it.

## 2. Pack (register projects + slots)

The pack installer then runs, per pack config:

```
farmslot project add <pack-url> --no-setup
```

This registers each project in the pack, clones its product repo(s) into
`<workspace>/repos/`, and creates the pack's declared slots. `--no-setup` keeps
first install fast — it proves prerequisites and creates slots **without** forcing
every native/browser build. A final demo/health check asserts the expected slot
counts.

A **slot** is one isolated repo + runtime sandbox an agent works in. Slot count,
ports, devices, and platform come from the pack's project configs and the machine
`pool/<host>.json`.

## 3. Customize (edit before real dispatch)

Registration seeds everything with placeholders. Before dispatching work that
needs secrets or points agents at your feature, edit the customization surfaces:

| Surface                | Path                                                       | Edit when                                          |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| **Secrets / fixtures** | `projects/<name>/fixtures/**` (copied from `.sample`)      | before any run needing real keys / a funded wallet |
| **Task prompts**       | `projects/<name>/templates/prompts/` + `templates/worker/` | you're steering agents at a different feature/task |
| **Machine config**     | `pool/<host>.json`                                         | tuning slots, ports, devices for your machine      |
| **Per-project**        | `projects/<name>/project.json` (`vars`, hooks)             | changing project-level behavior                    |

See the companion "Key files to edit" one-pager for the detail. Fixtures are
gitignored; task prompts and configs live in the pack's project repos.

## 4. Dispatch (operate)

Bring the local gateway up and connect a dashboard:

```
farmslot up
```

Then either:

- open the **hosted Command Center** at `https://farmslot.io/cc` (connects to your
  local gateway), or
- run the dashboard locally from a farmslot checkout via `yarn farmdev`.

From the Command Center you dispatch flows (fix-bug, review-pr, pr-complete,
feature, …) to free slots. Agents run in isolated slot sandboxes; runs are
archived under `<workspace>/runs/`.

## One-glance lifecycle

```
  install.sh ─► submodules ─► fixtures from .sample ─► farmslot framework install
       │                                                        │
       │                                              (prompts: workspace/bin/home)
       ▼                                                        ▼
  farmslot project add --no-setup ─► repos cloned + slots created
       │
       ▼
  EDIT: fixtures (secrets) · templates/ (task prompts) · pool/*.json · project.json
       │
       ▼
  farmslot up ─► Command Center (farmslot.io/cc or yarn farmdev) ─► dispatch flows
```

## 5. Uninstall (remove the framework)

`farmslot uninstall` is the counterpart to install. It reads `state.json`
(`bin_dir`, `home_dir`, workspace root) so a **custom** install is removed at its
real locations — not the defaults.

```
farmslot uninstall             # interactive: keep | back-up | delete run history + home, then confirm
farmslot uninstall --dry-run   # print the plan, remove nothing
farmslot uninstall --yes       # non-interactive; keeps run history + home/credentials
farmslot uninstall --purge     # also delete run history + home/credentials
```

Run history (`<workspace>/runs/`) and the home dir (gateway auth/profiles) default
to **keep** — deleting them is opt-in (`--delete-history` / `--delete-home` or
`--purge`); `--backup-history <path>` / `--backup-home <path>` archive them first.
Only a `farmslot` symlink that resolves **into this workspace** is removed; a
foreign one already on your `PATH` is left untouched.
