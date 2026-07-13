# Onboarding: install, add a pack, stay current

Two commands take a fresh machine to working farm slots; one keeps it current.

For a visual walk-through of the full lifecycle (what runs, what lands where, what
you customize, and how to remove it), see [onboarding-flow.md](onboarding-flow.md).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/deeeed/farmslot/main/install.sh | bash
```

From inside a checkout (dev/test mode), `bash install.sh` uses the checkout as
the source instead of cloning from a URL.

What it does:

- checks prerequisites (git, node per `engines`, yarn, tmux, python3) and agent
  runners (at least one of claude / codex / cursor-agent / grok). On macOS it
  can install missing common tools through Homebrew prompts
  (`FARMSLOT_AUTO_INSTALL=1` accepts those prompts non-interactively); otherwise
  it prints fix hints and stops.
- activates existing `asdf`/`nvm` installs in non-interactive shells and uses
  them to install/switch to the repo's recommended Node version when needed.
- on macOS, checks for the standalone `capture-helper` package and can install it
  with Homebrew or `npm install -g @siteed/capture-helper` unless
  `FARMSLOT_SKIP_CAPTURE_HELPER=1` is set. The installer doctors the package's
  native binary when available (`CAPTURE_HELPER_PATH` / `SITEED_CAPTURE_HELPER_BIN`
  can override it), avoiding wrapper shims for capture paths. Grant Screen
  Recording permission to the terminal app on first capture so Command Center can
  show live visual evidence. The legacy embedded helper under `tools/capture-helper/`
  has been removed.
- creates the workspace (default `~/farmslot`, override with
  `FARMSLOT_WORKSPACE`): `farmslot/` clone, `repos/`, `runs/`, `state.json`
- installs dependencies, builds the CLI's workspace packages, symlinks
  `farmslot` into `FARMSLOT_BIN_DIR` (default `~/.local/bin`)
- generates `pool/<hostname>.json` (zero slots, ports from 9300+). If the
  source checkout already owns that file, writes `<hostname>-onboard.json`
  instead — existing pool files are never overwritten
- ends with `farmslot doctor`

Re-running repairs/updates; it never duplicates.

## Pair the mobile companion

Install ends with an optional **Pair your phone** step unless `FARMSLOT_MINIMAL`
is set. It starts the local gateway and runs:

```bash
farmslot pair
```

The QR includes every reachable local LAN address. If Tailscale is installed,
signed in, and MagicDNS is available on the Mac, it also includes a
`ws://<machine>.<tailnet>.ts.net:<port>/ws` profile. Scan it from Companion
Settings → Pair from QR. For away-from-LAN use, sign the phone into the same
Tailnet before scanning; otherwise the LAN profile is still enough while the
phone and Mac are on the same network. Tailnet profiles use `ws://` because
Tailscale encrypts traffic at the WireGuard layer; only scan them on devices
that are signed into the expected tailnet.

If Tailscale was not available during install, pair over LAN first and rerun
`farmslot pair` after installing/signing into Tailscale on both devices.

## Add a project pack

```bash
farmslot project add <path-or-git-url>
```

Registers the pack's projects, blobless-clones product repos into
`<workspace>/repos/`, creates and validates the declared slots, runs the pack's
smoke check, prints the pack's action sheet, and finishes with doctor. See
[project packs](../reference/project-packs.md) for the pack contract.

Re-running with the same source is a no-op (verify only); a changed source
repairs in place. Slots are never duplicated.

## First dispatch (guided)

With a pack registered, dispatch without memorizing flags — bare `dispatch`
opens a guided picker on a TTY:

```bash
farmslot dispatch
```

It walks project → work source (a dispatchable backlog item, or a ticket/PR
ref + flow type) → slot (auto-picked by the shared selection core, overridable)
→ confirm. The same picker opens from `farmslot run create` when `--ticket` /
`--task` are omitted. Scripts keep the typed forms:

```bash
farmslot run create --project <p> --flow-type dev --ticket <ref> --json
farmslot backlog dispatch <MANUAL-000123>
```

Watch it land either interactively:

```bash
farmslot tui                        # full operator dashboard (fleet/backlog/runs)
farmslot fleet status --watch       # fleet table, live via fleet.updated events
```

## When something looks wrong (recovery)

The CLI tells you the exact next command on every failure (`Next: …` lines);
these are the common loops:

- **Stale fleet banner** (`STALE STATUS`) — the snapshot is too old to act on
  and dispatch/prepare suggestions are suppressed. Re-probe:

  ```bash
  farmslot fleet status --force-refresh
  ```

- **"Slot not found" / ghost slots** — a slot in the status file no longer
  exists in live pools. `farmslot fleet status` marks these `GHOST`; refresh
  reconciles them:

  ```bash
  farmslot fleet refresh
  farmslot doctor
  ```

- **No free slot for a project** — ask for the per-slot blocker list instead of
  guessing:

  ```bash
  farmslot fleet find-slot --project <name>
  ```

  Exit 1 prints why each slot is blocked (`agent working`, `manual mode`,
  `lifecycle=held (pr-watch)`, …) and the command that resolves it.

- **A run's PR merged out-of-band** (run stuck at its publication gate) — close
  the loop honestly instead of cancelling and re-dispatching:

  ```bash
  farmslot backlog close-shipped <MANUAL-000123> --pr owner/repo#456
  ```

- **Anything else** — the recovery surface in `farmslot tui` (key `4`)
  classifies the fleet (empty-pool / stale / ghosts / healthy) and prints the
  exact commands; `farmslot doctor` covers the machine-level checks.

## Stay current

```bash
farmslot update
```

- hard-updates the workspace clone to latest `main` (the clone is a tool, not a
  workspace — local edits are stashed with a warning first); dev/test installs
  re-sync from the source checkout's branch instead
- reinstalls dependencies and rebuilds the CLI packages
- applies versioned pool migrations (`migrations/pool/`) to this workspace's
  machine pool file — new defaults are added, user edits preserved, applied
  steps recorded in `state.json`
- re-runs the `sync` hook of any registered pack whose content hash changed
- ends with doctor

Note: the update engine itself runs from the pre-update code — when an update
changes `farmslot update`'s own logic, run it twice to pick the new engine up.

## Remove it

```bash
farmslot uninstall
```

Removes this installation at its recorded locations (reads `state.json`, so a custom
`FARMSLOT_WORKSPACE`/`BIN_DIR`/`HOME` is handled): the framework clone, product-repo
clones, `state.json`, and the `farmslot` PATH symlink. **Run history**
(`<workspace>/runs/`) and the **home dir** (gateway auth/profiles) default to _keep_ —
each is an interactive keep / back-up / delete choice.

- `--dry-run` — print the plan, remove nothing
- `--yes` — non-interactive; keeps history + home unless `--purge`
- `--purge` — also delete history + home/credentials
- `--backup-history <path>` / `--backup-home <path>` — archive before removing

Only a `farmslot` symlink that resolves into this workspace is removed; a foreign one
on your `PATH` is left untouched.

## Manage multiple gateways

The CLI targets any number of gateways through named profiles (ADR-036),
stored machine-level in `~/.farmslot/gateways.json` (0600 — secrets never
appear in command output):

```bash
farmslot gateway add lab wss://lab-host:7777   # first profile becomes active
farmslot login lab --token <token>      # or --password <p> / --code <pairing-code>
farmslot auth status --all              # authenticated / not signed in / unreachable per profile
farmslot fleet status --gateway lab     # any command can target a profile
farmslot gateway use lab                # set the default for future commands
farmslot logout lab                     # forget the stored credential
```

Resolution order per invocation: `--url` > `--gateway <name>` > `GW_URL` env >
active profile > `ws://localhost:7777`. `login` verifies against the gateway's
existing `auth.connect` / pairing flow before storing anything; a wrong
credential is never persisted. Prefer `--code` (pairing) on shared machines —
`--token`/`--password` values land in shell history. Local single-gateway use needs no profiles at
all.

## Check health anytime

```bash
farmslot doctor
```

Green checklist (prereqs, runners, workspace, pool, packs, CLI, gateway
profiles) or specific failures with fix hints. Exit code reflects status.

### Fast pack registration

For heavyweight packs, prefer a registration-only first pass:

```bash
farmslot project add <pack> --no-setup
```

This proves the workspace, pack contract, slot registration, repo clones, and fixtures without running product builds. Follow with a focused full setup when ready:

```bash
farmslot project add <pack> --project <project-name>
```
