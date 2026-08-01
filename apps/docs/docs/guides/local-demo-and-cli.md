---
title: Local demo and CLI access
---

# Local demo and CLI access

This guide gets a local Farmslot gateway running, opens Command Center, and shows how terminals or agents can talk to the same gateway through the `farmslot` CLI.

## Start the local demo

From the repository root:

```bash
bash scripts/dev.sh
```

Open [http://localhost:7777](http://localhost:7777). The local demo pool exposes `demo-ff-1`, a scripted-runner validation path that is safe to inspect and dispatch against while learning the product.

Command Center is the primary operator surface: use it to see the fleet, inspect slot readiness, watch runs, review artifacts, and steer work.

## Use the CLI against the gateway

The `farmslot` CLI is for terminals, scripts, and agent shells. It speaks to the gateway over WebSocket and can target any reachable gateway.

When running from this repo before package publication, use the workspace script:

```bash
yarn workspace @farmslot/cli farmslot fleet status
yarn workspace @farmslot/cli farmslot slot check demo-ff-1
```

Once installed as a binary, the same calls are:

```bash
farmslot fleet status
farmslot slot check demo-ff-1
```

Target another gateway with `--url`:

```bash
farmslot --url ws://host:7777 fleet status
```

Use `--json` for machine-readable output.

## Raw gateway RPC

Agents and scripts can call protocol methods directly:

```bash
farmslot rpc fleet.status '{}'
farmslot rpc gateway.status '{}'
```

There is no runtime discovery method, so look the method set up ahead of time: see [Gateway API capability surface](../reference/gateway-api.md) for the curated API overview, including safety tiers.

## Slot lifecycle commands

```text
ready -> dispatching -> working -> recycling -> ready
```

| CLI command                  | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `farmslot fleet status`      | Fleet-wide overview of machines, slots, health, and current runs.          |
| `farmslot slot check <id>`   | Read-only deep health check for one slot.                                  |
| `farmslot slot prepare <id>` | Sync fixtures, checkout branch, and run project preflight.                 |
| `farmslot dispatch preview`  | Preview slot/project fit before creating a run.                            |
| `farmslot run create ...`    | Create a supervised run from a Jira/GitHub ref or an existing `TASK.md`.   |
| `farmslot slot release <id>` | Collect artifacts, clean up, and optionally re-prepare with `--keep-warm`. |
| `farmslot rpc <method>`      | Raw gateway escape hatch for protocol methods and agent integrations.      |

Create runs from either source:

```bash
farmslot run create --project audiolab-farm --flow-type dev \
  --ticket https://github.com/deeeed/audiolab/issues/414 \
  --slot mini-audiolab-1

farmslot run create --task projects/audiolab-farm/tasks/dev/example/TASK.md \
  --slot mini-audiolab-1
```

## About the shell scripts

The `scripts/*.sh` lifecycle commands are lower-level building blocks used by the gateway, CLI, and local debugging. They remain useful for development and recovery, but they are not the public getting-started surface.
