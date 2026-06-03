# ADR-005: State Persistence

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [PRD](../PRD-command-center-canonical.md) — Open Question #4, [ADR-008](008-remote-communication.md)

## Context

Farmslot's fleet state lives in `.farm-status.json` — a flat JSON file at the repo root. Every script reads and writes it atomically (via Python's `json.dump` with a temp file + rename). The file is the single source of truth for slot lifecycle, health, task tracking, and dispatchability.

OpenClaw uses JSON files for state persistence too (sessions, config, pairing) — not a database. In-memory cache with version counters, broadcast on change.

With the node agent pattern (ADR-008), state management evolves: agents push real-time updates instead of the gateway polling a file.

## Options Considered

### A. Keep `.farm-status.json` as Primary

Gateway watches the file with chokidar, caches in memory, pushes events to UI on change. Scripts continue writing to it.

**Pros:**

- Zero migration
- Scripts still work alongside gateway during transition
- Simple, proven, debuggable (it's just a JSON file)

**Cons:**

- No history — overwritten on every update
- No query capability (full file read every time)
- File-watching has edge cases (atomic writes, rapid updates)
- Becomes awkward once node agents are pushing real-time state

### B. SQLite

Replace JSON file with SQLite database. Gateway owns writes. Scripts query via CLI or gateway API.

**Pros:**

- Query capability (find all working slots, filter by project)
- History (append rows, not overwrite)
- Atomic transactions
- Analytics foundation (token usage, task duration, nudge counts)

**Cons:**

- Scripts must be rewritten to use gateway API or SQLite CLI
- Breaks the "both systems work side by side" promise from ADR-001
- SQLite file locking with concurrent writers
- Heavier than needed for <20 slots

### C. In-Memory State + JSON Snapshots

Gateway owns state in memory. Persists snapshots to JSON periodically. Node agents push updates to gateway, gateway is the single writer.

**Pros:**

- Real-time state owned by gateway (no file-watching lag)
- JSON snapshots for crash recovery (reload on restart)
- No concurrent writer issues — gateway is the only writer
- Natural fit with node agent pattern (ADR-008)
- Compatible with `.farm-status.json` format for backward compat

**Cons:**

- State lost on gateway crash between snapshots (mitigated by frequent snapshots + event log)
- Scripts can't write directly anymore — must go through gateway API
- Gateway becomes a required dependency (not just an optional viewer)

### D. In-Memory + Append-Only Event Log

Same as C, plus an append-only log of state changes for history and analytics.

```
gateway-state.json       — current snapshot (replaces .farm-status.json)
gateway-events.jsonl     — append-only log: {timestamp, event, slot, before, after}
```

**Pros:**

- All benefits of C
- Full history for analytics (PRD category G)
- Event log = training data for scoring calibration
- Debuggable — replay events to understand what happened

**Cons:**

- Log file grows unbounded (mitigated by rotation)
- More complexity than C

## Decision

**Option C — In-Memory State + JSON Snapshots** for v1. Add event log (Option D) in v2 for analytics.

### Rationale

With node agents (ADR-008) pushing real-time state and the gateway being pure TypeScript (ADR-001), the gateway naturally becomes the state owner. Having it also watch a file that other writers modify is a half-measure that creates race conditions.

The clean model: gateway owns state. Node agents push updates. UI reads from gateway. JSON snapshot for crash recovery. Scripts either go through the gateway API or are retired.

### State Model

```typescript
class FleetState {
  private slots: Map<string, SlotStatus>;
  private version: number;
  private snapshotPath: string;

  // Called by node agent updates
  updateSlot(slotId: string, changes: Partial<SlotStatus>): void {
    this.slots.set(slotId, { ...this.slots.get(slotId)!, ...changes });
    this.version++;
    this.broadcast('slot.changed', { slotId, slot: this.slots.get(slotId) });
    this.scheduleSnapshot();
  }

  // Periodic + on-change persistence
  private async snapshot(): Promise<void> {
    const data = { checkedAt: new Date().toISOString(), slots: [...this.slots.values()] };
    await writeFileAtomic(this.snapshotPath, JSON.stringify(data, null, 2));
  }

  // On gateway startup
  static async load(path: string): Promise<FleetState> {
    const data = JSON.parse(await readFile(path, 'utf-8'));
    // Populate from snapshot, mark all slots as "pending reconnect"
    // Node agents will push real state when they connect
  }
}
```

### Backward Compatibility

During migration:

- Gateway writes snapshots in `.farm-status.json` format — existing scripts can still read it
- Gateway also exposes `fleet.status` RPC — new clients use that
- Once all scripts are retired (end of ADR-001 migration), the JSON snapshot becomes internal

## Consequences

**Positive:**

- Single source of truth — no file-watching race conditions
- Real-time state from node agents
- Clean crash recovery via snapshots
- Foundation for event log (v2 analytics)

**Negative:**

- Gateway becomes a required dependency — scripts can't work without it
- Must coordinate with ADR-001 migration phases (scripts → gateway)

## References

- OpenClaw health state: `/Users/deeeed/dev/openclaw/src/gateway/server/health-state.ts` (version counter + broadcast pattern)
- Current state file: `/Users/deeeed/dev/farmslot/.farm-status.json`
