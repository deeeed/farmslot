# Onboarding: install, add a pack, stay current

Two commands take a fresh machine to working farm slots; one keeps it current.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/farmslot/main/install.sh | bash
```

From inside a checkout (dev/test mode), `bash install.sh` uses the checkout as
the source instead of cloning from a URL.

What it does:

- checks prerequisites (git, node per `engines`, yarn, tmux, python3) and agent
  runners (at least one of claude / codex / cursor-agent) — prints install
  hints, never auto-installs
- creates the workspace (default `~/dev/farmslot-workspace`, override with
  `FARMSLOT_WORKSPACE`): `farmslot/` clone, `repos/`, `runs/`, `state.json`
- installs dependencies, builds the CLI's workspace packages, symlinks
  `farmslot` into `FARMSLOT_BIN_DIR` (default `~/.local/bin`)
- generates `pool/<hostname>.json` (zero slots, ports from 9300+). If the
  source checkout already owns that file, writes `<hostname>-onboard.json`
  instead — existing pool files are never overwritten
- ends with `farmslot doctor`

Re-running repairs/updates; it never duplicates.

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

## Stay current

```bash
farmslot update
```

- hard-updates the workspace clone to latest `main` (the clone is a tool, not a
  workspace — local edits are stashed with a warning first); dev/test installs
  re-sync from the source checkout's branch instead
- reinstalls dependencies and rebuilds the CLI packages
- applies versioned pool migrations (`migrations/pool/`) — new defaults are
  added, user edits preserved, applied steps recorded in `state.json`
- re-runs the `sync` hook of any registered pack whose content hash changed
- ends with doctor

## Check health anytime

```bash
farmslot doctor
```

Green checklist (prereqs, runners, workspace, pool, packs, CLI) or specific
failures with fix hints. Exit code reflects status.
