# ADR-015: Resource Streams — Project-Driven Multi-Stream Model

**Status:** Accepted
**Date:** 2026-03-28
**Relates to:** [ADR-012](012-device-screen-streaming.md) (device screen streaming), [ADR-010](010-slot-view-layout.md) (slot view layout)

## Context

ADR-012 established H.264 device screen streaming via scrcpy/ScreenCaptureKit + WebCodecs. The implementation works for a single stream per slot, toggled between iOS/Android/Extension via platform buttons in a collapsible right column.

As usage grows, several limitations have emerged:

1. **Stream competes with terminal for space** — the right column steals width from the editor/terminal area. You can't comfortably see both code and a device feed.
2. **Only one stream visible at a time** — mobile projects need iOS + Android side-by-side for cross-platform validation.
3. **No resource lifecycle controls** — booting/shutting down simulators, emulators, or browsers requires terminal commands. The UI has no power controls.
4. **Hardcoded platform assumptions** — the `_streamPlatform` toggle in slot-view assumes `ios | android | chrome-extension`. New project types (web apps, desktop apps) would require code changes.
5. **Always-or-nothing streaming** — the device column is either open (streaming) or collapsed. There's no concept of "resource is available but not actively streaming."
6. **No project-driven resource discovery** — what resources a slot has depends on hardcoded platform detection, not project configuration.

The core insight: **every project has managed resources** (simulators, emulators, browsers, native apps) that may be streamable, controllable, or both. The streaming system should be driven by project configuration, not hardcoded platform enums.

## Options Considered

### A. Extend Current Device Column

Add multi-stream support to the existing `sv-stream-col` / `sv-stream-collapsed` pattern. Stack multiple `<device-feed>` instances vertically in the right column. Add control buttons to the column header.

**Pros:**

- Minimal code changes
- Layout already works

**Cons:**

- Column layout doesn't scale beyond 2 streams (vertical stacking gets tiny)
- Still competes with editor for horizontal space
- Platform discovery remains hardcoded
- No on-demand activation — column is open or closed

### B. Project-Driven Resource Model with On-Demand Streams

New `resources` field in `project.json` declares available resources per project. UI discovers resources on slot load, shows them as chips in the header bar. Clicking a chip opens a split layout with code left + stream right. Multiple streams stack in the stream panel. Resource lifecycle (boot/shutdown/relaunch) controlled via hooks.

**Pros:**

- Project-driven — no hardcoded platform assumptions
- On-demand — resources visible but not streaming until activated
- Multi-stream — up to 8 concurrent streams per client
- Controllable — boot/shutdown/relaunch via project hooks
- Backward compatible — missing `resources` field falls back to `platforms` object

**Cons:**

- Larger scope — new components, protocol methods, gateway module
- Binary protocol change (resource index in flags byte)
- Layout complexity (split view, resizable divider)

### C. Separate Resource Dashboard Route

New `#resources/{slotId}` route with a dedicated grid of streams and controls, separate from the slot workspace.

**Pros:**

- No layout changes to slot-view
- Full screen for streams

**Cons:**

- Context switch — can't see code and streams simultaneously
- Duplicates slot identification (header, navigation)
- Doesn't solve the "quick glance at device" use case

## Decision

**Option B — Project-driven resource model with on-demand streams.**

### Rationale

- The resource model generalizes cleanly: device feeds, browser windows, log streams, and future resource types all fit the same pattern (declare in project.json, discover on load, stream on demand, control via hooks)
- On-demand activation solves the space problem — streams don't consume layout until the user wants them
- Resource chips in the header bar provide always-visible discovery without consuming space
- The binary protocol change (resource index in flags bits 1-3) is backward compatible — single-stream clients see index 0
- Hook-based lifecycle (boot/shutdown/relaunch) matches the existing `expandHook()` pattern in `lib/slot-common.sh` and `core/hooks.ts`

### Data Model

**`project.json` — new `resources` field:**

```jsonc
{
  "resources": {
    "ios-sim": {
      "type": "device-stream",
      "platform": "ios",
      "label": "iOS Simulator",
      "streamable": true,
      "controllable": true,
      "hooks": {
        "boot": "xcrun simctl boot '{{IOS_SIMULATOR}}'",
        "shutdown": "xcrun simctl shutdown '{{IOS_SIMULATOR}}'",
        "relaunch": "xcrun simctl terminate '{{IOS_SIMULATOR}}' io.example-app && xcrun simctl launch '{{IOS_SIMULATOR}}' io.example-app",
      },
    },
    "android-emu": {
      "type": "device-stream",
      "platform": "android",
      "label": "Android Emulator",
      "streamable": true,
      "controllable": true,
      "hooks": {
        "boot": "$ANDROID_HOME/emulator/emulator -avd {{ANDROID_AVD}} -port {{ADB_PORT}} &",
        "shutdown": "adb -s {{ADB_SERIAL}} emu kill",
        "relaunch": "adb -s {{ADB_SERIAL}} shell am force-stop io.example-app && adb -s {{ADB_SERIAL}} shell monkey -p io.example-app 1",
      },
    },
  },
}
```

**Backward compatibility:** If no `resources` field exists, the gateway derives resources from the existing `platforms` object. Each platform key becomes a resource with `streamable: true, controllable: false`.

**Protocol types:**

```typescript
interface ResourceDefinition {
  type: 'device-stream' | 'browser-stream' | 'logs' | 'custom';
  platform?: string; // links to platforms[key]
  label: string;
  streamable: boolean;
  controllable: boolean;
  hooks?: {
    boot?: string;
    shutdown?: string;
    relaunch?: string;
    health?: string;
  };
}

interface SlotResource {
  id: string; // "ios-sim", "android-emu", "browser"
  definition: ResourceDefinition;
  status: 'unknown' | 'running' | 'stopped' | 'error';
}
```

**Protocol methods:**

| Method             | Params                           | Result                          |
| ------------------ | -------------------------------- | ------------------------------- |
| `resource.list`    | `{ slotId }`                     | `{ resources: SlotResource[] }` |
| `resource.control` | `{ slotId, resourceId, action }` | `{ ok, detail? }`               |

No new stream methods — `stream.subscribe` already accepts a `platform` param.

### Multi-Stream Binary Protocol

The existing binary frame header uses a 14-byte format with byte 1 as flags (only bit 0 = keyFrame used). Bits 1-3 of the flags byte are repurposed as a **resource index** (0-7):

```
Byte 1 (flags):
  bit 0     = keyFrame (unchanged)
  bits 1-3  = resourceIndex (0-7)
  bits 4-7  = reserved
```

Gateway assigns an index per subscription per client. The subscribe response returns `{ resourceIndex: N }`. Client-side `<stream-feed>` filters incoming frames by index match.

- Single-stream clients see index 0 — no breakage
- Supports up to 8 concurrent streams per client
- No header size change, no wire compatibility break

### Layout System

Three layout modes within slot-view:

**`none`** (default) — No stream panel. Resource chips visible in header but dim. Full editor + terminal layout. Nothing streams until the user clicks a chip.

**`split`** (primary) — Editor on left, stream panel on right. Resizable split (default ~65/35). The stream panel holds 1 stream (common) or 2 stacked vertically (iOS+Android). Each stream manages its own subscribe/unsubscribe.

```
+----------------------------------------------------+
| runner-mobile-1  ready  [iOS *] [And o]                |
+------------------+--------+------------------------+
| sidebar | editor | resize | stream (iOS)           |
|         |        | handle |                        |
|         +--------+--------+------------------------+
|         | terminal                                  |
+---------+-------------------------------------------+
```

**`streams-only`** (future) — Streams replace the editor area. For monitoring/watching mode. Deferred until there's demand.

### On-Demand Lifecycle

1. Slot loads -> discover resources -> shown as inactive chips in header
2. Click chip -> `stream.subscribe` -> split view opens (code + stream)
3. Click second chip -> second stream stacks below first in stream panel
4. Click active chip -> `stream.unsubscribe` -> that stream closes; if last, returns to full editor
5. Navigate away -> all streams unsubscribe automatically
6. Layout preference + active resources persisted in localStorage

### Component Architecture

**New components:**

- `resource-panel.ts` — container managing subscriptions + stream grid
- `resource-toolbar.ts` — resource chips, layout toggle, control buttons
- `resource-grid.ts` — CSS grid of 1-4 `<stream-feed>` instances

**Modified components:**

- `slot-view.ts` — replace `sv-stream-col` with `<resource-panel>`, add layout mode toggle
- `stream-feed.ts` — add `resourceIndex` prop for binary frame filtering
- `binary-codec.ts` — extract `resourceIndex` from flags bits 1-3

**New gateway modules:**

- `resource-manager.ts` — `resolveSlotResources()`, `executeResourceControl()`, hook expansion
- `methods/resource.ts` — `resource.list`, `resource.control` handlers

## Amendment: Resource Status Push (2026-03-31; terminology updated by ADR-020)

**Terminology:** ADR-020 renamed the per-machine daemon from "agent" to "node". In this ADR, "node" means the Farmslot daemon in `services/node`; "agent" is reserved for LLM workers running inside slots.

**Problem:** Resource status relies on 60s pull-based polling with gateway-side health hook execution. Between polls, UI shows stale data — slots show green "running" when browsers/devices are dead.

**Decision:** Node-owned reactive resource monitoring. The node is the single source of truth for resource state on its machine.

**Flow:**

1. Gateway sends `resource.watch.start { slotId, resources: [...] }` to the node on connect
2. Node watches the specified resources (PID files, ports, processes) on its machine
3. Node emits `node.resource.changed { machine, slotId, resourceId, status, pid?, oldPid?, newPid?, at?, meta? }` on state change
4. Gateway updates cache + broadcasts `resource.status.updated { slotId, resources }` to UI
5. On node disconnect → gateway marks all that machine's resources as `unknown`
6. 60s poll kept as reconciliation only

**Watch types:**

| Type           | Node method                                  | Emits on                                 |
| -------------- | -------------------------------------------- | ---------------------------------------- |
| `pid-file`     | `fs.watch` on directory + periodic `kill -0` | PID file create/delete, zombie detection |
| `port-listen`  | periodic local TCP connect probe             | port open/closed                         |
| `process-poll` | periodic shell command execution             | exit code change                         |

`process-poll` also supports an additive shared-provider hint. The command remains
the compatibility fallback for older nodes; an upgraded node uses the provider to
run one host inventory query and fan the result out to every matching slot watch.

```jsonc
"ios-sim": {
  "watch": {
    "type": "process-poll",
    "provider": "ios-simulator-inventory",
    "target": "{{simulator}}",
    "cmd": "xcrun simctl list devices booted 2>/dev/null | grep -q '{{simulator}}'"
  }
}
```

The iOS provider runs `simctl` once per node cycle, indexes booted devices by name
and UDID, then updates every registered slot. It enforces a 30-second minimum
interval, shares the existing global process-poll concurrency budget, never overlaps
its own polls, ignores results for replaced watches, and preserves cached status on
transient inventory failure. Node health exposes cumulative shared execution,
fan-out, failure, and duration counters so a future slot-count multiplier is visible.

**Config:** `watch` field added to `ResourceDefinition` in `project.json`:

```jsonc
"browser": {
  "watch": { "type": "pid-file", "path": "{{runtime_dir}}/browser.pid" },
  // ...
}
```

Gateway expands template vars to absolute paths before sending to the node. The node doesn't need pool/project config.

## Amendment: Cached Resource Discovery Contract (2026-06-06)

**Problem:** Fleet-wide UI affordances such as the Devices page `All Running` button must list active streamable resources quickly. Running `resource.health` for every slot from the UI/gateway path turns discovery into a slow full-machine scan (`simctl`, ADB, `capture-helper`, browser pid repair), causing missing macwork resources, long waits, and inconsistent results.

**Decision:** Resource discovery is cache-first. The node owns machine-local observation and pushes status changes for every configured watched resource on its machine, regardless of whether the slot currently has an active run. The gateway stores that pushed cache and serves `resource.list`/fleet resource summaries from it. UI surfaces that need an active-resource list read the cache only; they do not trigger full health checks inline.

**Refresh semantics:** Explicit refresh actions may request a full check (`resource.health` / operator refresh), but that is an operator-initiated reconciliation path, not the normal discovery path. If a full check is slow or unavailable, the last pushed node cache remains the UI's best current value and may be marked `unknown`/stale separately.

**Streamability:** For stream grids, `running` should mean the resource is expected to be stream-capturable, not merely that a process exists. For browser resources, node/gateway health may repair stale CDP/browser pid files, but must not mark a browser stream running when `capture-helper resolve --pid` cannot find a capturable window.

## Amendment: Resource Pressure Controls (2026-06-06)

**Problem:** Resource streams and node-owned watches make stale simulators, dev servers, browsers, and other project runtimes visible, but visibility alone does not relieve local machine pressure. Project-specific teardown shortcuts can stop those resources, but they are outside the typed Farmslot protocol and cannot be safely exposed from Command Center or future node-management surfaces.

**Decision:** Add typed resource pressure controls on top of the existing project-driven resource model:

- `resource.cleanup` previews or executes shutdown for idle `running`/`stale` resources that declare a configured `shutdown` hook.
- `resource.watch.setEnabled` pauses/resumes node resource watches at runtime. Pausing watches marks cached resources for affected machines `unknown`; explicit health checks remain operator-driven.
- Gateway Intelligence exposes a read-only resource pressure snapshot that combines machine health, slot activity, resource status counts, and dry-run cleanup candidates for diagnosis.
- Command Center exposes these controls from the fleet resource view as an operator action, not an autonomous recovery.

**Authority boundary:** Cleanup must use configured resource hooks through `resource.control`/gateway resource-manager paths. It must not hardcode project names, ports, process patterns, or raw `pkill` logic in Farmslot. Projects that need custom teardown semantics should express those semantics in their `project.json` resource shutdown hooks.

**Safety defaults:** Cleanup defaults to dry-run preview and always excludes busy, held, actively working, manual, disabled, and current-run slots. Live cleanup additionally requires a non-empty exact reviewed target set. Preview and live target envelopes are capped at 256 entries, and resolution/verification failures remain attached to their exact reviewed row instead of aborting unrelated targets. This keeps pressure relief targeted at stale background resources rather than active or retained runs.

**Diagnosis boundary:** The read-only pressure snapshot must report the runtime watch state. If watches are paused, cached resource statuses may be `unknown`; machine health and slot activity remain the primary pressure evidence. Resource cleanup is not a substitute for stopping active builds or retained run slots; those require their owning lifecycle controls. Watch pause/resume is persisted in the gateway's local runtime cache so node reconnects or gateway restarts do not silently re-arm an operator-paused watch set.

**Bounded process attribution (2026-08-20):** The private node-to-gateway metrics sample may attach one ownership-safe process census (`pid`, `ppid`, CPU, RSS, elapsed time, executable name/path; never argv or environment). It reuses the metrics cadence, runs at most once per minute under pressure and once per five minutes otherwise, and is capped by time, output bytes, and retained entries. Concurrent requests share one census while merging newly observed ownership PIDs into that sample; ad-hoc gauge RPCs cannot consume the pending census before the subscribed gateway event. The gateway stores the census separately from `MachineHealth.system`, so fleet health events and ordinary health readers never receive raw PID/path data. The admin-only pressure RPC caps machines, history, groups, and cleanup candidates, reports omitted counts, prioritizes critical/high-pressure machines at the envelope boundary, treats explicit empty selectors as match-none, scopes managed identities to project filters, and reuses resolved resource definitions for 30 seconds. Command Center forwards the active global machine/project scope, applies slot search locally, and discards stale overlapping responses; project-scoped views retain whole-host gauges and unmapped roots without exposing other projects' managed identities. The Co-Pilot projection removes PIDs, paths, and exact cleanup targets and caps history/groups again. Attribution is display-only: stale/manual/unknown classes do not authorize process termination, and cleanup remains exclusively hook-driven through `resource.cleanup`.

## Consequences

**Positive:**

- Project-driven resource discovery — new project types work without code changes
- On-demand streaming — no wasted bandwidth or layout space until needed
- Multi-stream support — iOS + Android side-by-side for cross-platform validation
- Resource lifecycle controls — boot/shutdown/relaunch from the UI
- Backward compatible — existing projects without `resources` field get auto-derived resources
- Binary protocol unchanged for single-stream clients (index 0 default)

**Negative:**

- More components to maintain (resource-panel, toolbar, grid)
- Layout complexity increases (split view + resizable divider + stacked streams)
- Binary flags byte now has multiple concerns (keyframe + resource index)
- Resource status tracking adds gateway state management

**Risks:**

- Hook execution for resource control (boot/shutdown) may have long timeouts — need progress streaming
- Resource index bits (3 bits = 8 slots) sufficient for foreseeable use cases but not extensible without header change
- Split layout resizing may interact poorly with Monaco editor (needs explicit `editor.layout()` calls on resize)
