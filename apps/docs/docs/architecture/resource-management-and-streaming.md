---
title: Resource management and streaming
---

Farmslot treats each slot as a small runtime environment with managed resources:
simulators, emulators, browsers, dev servers, logs, and future project-specific
processes. The model is project-driven so Farmslot does not need hardcoded
knowledge of Metro, webpack, iOS, Android, or browser process names.

## Resource model

Projects declare resources in `project.json`:

- `type` — device, browser, dev server, or service.
- `streamable` — whether Command Center can open a live stream.
- `controllable` — whether lifecycle buttons are available.
- `hooks` — project-owned `boot`, `shutdown`, `relaunch`, and `health` commands.
- `watch` — node-local observation such as a PID file, port listener, or process poll.

The gateway expands slot/project template variables before invoking hooks or
sending watch instructions. Project config owns platform-specific details; the
shared protocol owns discovery, status, control, and streaming.

## Node-owned status

The per-machine Farmslot node observes resources locally and pushes changes to
the gateway:

1. Gateway sends `resource.watch.start` to the node.
2. Node watches PID files, ports, or project-defined process probes.
3. Node emits `node.resource.changed`.
4. Gateway updates its cache and broadcasts `resource.status.updated`.
5. Command Center renders resource grids from the cached status.

Explicit refresh actions can run full health checks, but normal UI discovery is
cache-first so a fleet view does not trigger expensive `simctl`, ADB, browser, or
capture probes for every slot.

## Streaming

Streaming is on demand. A resource can be visible in Command Center without
streaming. When an operator opens a stream, the UI calls the stream subscription
RPC for that slot/resource; the gateway routes capture through the node and sends
frames back to the browser.

Browser resources must be stream-capturable, not just alive as a process. When a
browser PID file is stale, the gateway/node path can repair it from the Chrome
DevTools Protocol port and verify that `capture-helper` can resolve the window.

## Pressure relief

Resource status also powers operational cleanup. Command Center can preview and
run resource cleanup for idle resources:

- Cleanup targets only `running` or `stale` resources.
- Busy or actively working slots are excluded by default.
- Shutdown always goes through the configured resource `shutdown` hook.
- Farmslot does not hardcode `pkill`, Metro ports, webpack commands, or simulator
  names in the shared layer.

This lets project-specific teardown behavior live in resource hooks while
exposing a generic Farmslot protocol action.

Operators can also pause and resume resource watches at runtime. Pausing watches
stops background observation and marks affected cached statuses as `unknown`;
manual refresh and resource control remain explicit operator actions.

## Gateway Intelligence boundary

Co-Pilot reads the same abstraction through a read-only resource pressure
snapshot. The snapshot combines machine health, slot activity, cached resource
status counts, and dry-run cleanup candidates so Gateway Intelligence can explain
why a machine looks slow and propose next steps.

The snapshot is evidence, not an actuator. Cleanup, resource control, and watch
pause/resume remain typed operator actions that must be surfaced separately from
diagnosis.

Cleanup is idle-only by default. If machine pressure comes from actively working
builds, dev servers, or simulators, the snapshot should identify busy/working
slots and pressure signals so an operator can decide whether to cancel, release,
or explicitly include busy slots. The default cleanup action does not stop active
runs.

When watches are paused, the gateway persists that runtime state under its local
cache so a restart or node reconnect does not silently re-arm watches. The
snapshot reports the watch state because cached resource statuses may become
`unknown`. Machine health and slot activity remain available as the pressure
evidence while resource caches are intentionally quiet.

## Architecture anchors

This page summarizes decisions from:

- ADR-008: remote machine communication through the Farmslot node.
- ADR-015: project-driven resource streams, lifecycle controls, node status
  watches, cached discovery, and pressure controls.
- ADR-020: node terminology for the per-machine daemon.
